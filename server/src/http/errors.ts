// AppError + toAppError (REFACTORING_ROADMAP S1 / P1-01) — the one place that turns a thrown value
// into an HTTP status and a `{ code, error, ...details }` body. Used by the central error handler
// (errorHandler.ts) for anything a route handler throws or rejects with.
//
// The domain-class table below repeats the responses the route handlers already send from their
// own try/catch blocks (status, code, message and extra keys byte for byte). In S1 those handler
// catches stay; the table is the safety net for an error that escapes one. When S7 moves the
// catches into services, the handler's response must match this table (check per PR).
//
// ZodError is deliberately NOT mapped to 400. Route handlers validate request bodies with
// `safeParse` and answer 400 themselves; the only `.parse()` that can throw on an HTTP path is the
// internal result-integrity check (statsDescriptiveStratifySuppression.ts), which is a server
// defect and must stay a 500 — mapping it to 400 would report a server bug as the client's fault
// and echo internal schema paths. (Deviation from the Phase 1 plan's "ZodError → 400"; reported.)
import {
  IdentityCaseLockedError,
  IdentityForbiddenError,
  IdentityRevisionMismatchError,
  IdentitySetChangedError,
  IdentityTargetNotFoundError,
} from '../db/patientIdentityCorrection';
import { PatientLockForbiddenError, PatientLockTargetNotFoundError } from '../db/patientLocks';
import { PatientIdentityConflictError, PatientPersonVanishedError } from '../db/patientPersons';
import {
  StatsEngineBusyError,
  StatsEngineCancelledError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
} from '../statsEngine';
import { errorBodyFor, httpStatusFor } from '../statsEngineErrorMapping';

export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  /** Extra top-level keys of the response body (e.g. `currentRevision`). */
  readonly details?: Record<string, unknown>;
  /** Added to the body as `retriable: true` when set (clients retry the same request). */
  readonly retriable?: boolean;

  constructor(
    status: number,
    code: string,
    message: string,
    details?: Record<string, unknown>,
    options: { retriable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retriable = options.retriable;
  }
}

export const INTERNAL_ERROR_CODE = 'INTERNAL_ERROR';
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

function internal(cause: unknown): AppError {
  return new AppError(500, INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE, undefined, { cause });
}

const ASSIGNED_DOCTOR_ONLY = 'Only the assigned doctor can modify this patient';

const STATS_ENGINE_ERRORS = [
  StatsEngineBusyError,
  StatsEngineCancelledError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
] as const;

function isStatsEngineError(err: unknown): boolean {
  return STATS_ENGINE_ERRORS.some((cls) => err instanceof cls);
}

function pgCode(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined;
  const code = (err as Error & { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  // body-parser (express.json) — same response as before S1.
  if (err instanceof Error && (err as Error & { type?: unknown }).type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large', undefined, { cause: err });
  }

  // --- domain errors (responses identical to the handlers' own catch blocks) ---
  if (err instanceof PatientLockTargetNotFoundError || err instanceof IdentityTargetNotFoundError) {
    return new AppError(404, 'PATIENT_NOT_FOUND', 'Patient not found', undefined, { cause: err });
  }
  if (err instanceof PatientLockForbiddenError) {
    return new AppError(403, 'FORBIDDEN', ASSIGNED_DOCTOR_ONLY, undefined, { cause: err });
  }
  if (err instanceof IdentityRevisionMismatchError) {
    return new AppError(409, 'CONFLICT', 'Revision mismatch.', { currentRevision: err.currentRevision }, { cause: err });
  }
  if (err instanceof IdentityForbiddenError) {
    return err.requiresAdmin
      ? new AppError(403, 'IDENTITY_CORRECTION_REQUIRES_ADMIN',
        'This patient number has multiple active cases; only an administrator can correct it', undefined, { cause: err })
      : new AppError(403, 'FORBIDDEN', ASSIGNED_DOCTOR_ONLY, undefined, { cause: err });
  }
  if (err instanceof IdentityCaseLockedError) {
    return new AppError(423, 'LOCK_HELD', err.message, undefined, { cause: err });
  }
  if (err instanceof IdentitySetChangedError) {
    return new AppError(409, 'IDENTITY_SET_CHANGED',
      'Related cases kept changing while applying the correction. Please retry.', undefined, { retriable: true, cause: err });
  }
  if (err instanceof PatientIdentityConflictError) {
    return new AppError(409, 'PATIENT_IDENTITY_CONFLICT',
      'This patient number belongs to an existing patient with a different birth date', undefined, { cause: err });
  }
  if (err instanceof PatientPersonVanishedError) {
    return new AppError(409, 'PATIENT_PERSON_VANISHED',
      'The patient identity was modified concurrently. Please retry.', undefined, { retriable: true, cause: err });
  }
  if (isStatsEngineError(err)) {
    const body = errorBodyFor(err);
    return new AppError(httpStatusFor(err), body.code, body.error, undefined, { cause: err });
  }

  // --- PostgreSQL ---
  const code = pgCode(err);
  if (code === '23505') {
    const constraint = (err as Error & { constraint?: unknown }).constraint;
    return new AppError(409, 'UNIQUE_VIOLATION', 'Resource already exists',
      typeof constraint === 'string' ? { constraint } : undefined, { cause: err });
  }
  // 40P01 (deadlock) is not retried here — withDeadlockRetry does that around the transaction.
  // It falls through to 500; the log line keeps the pg code (logger.serializeError).

  // Everything else — including a ZodError from an internal .parse() (see the file header).
  return internal(err);
}

/** Response body for an AppError: `{ code, error, ...details, retriable? }`. */
export function errorBody(appError: AppError): Record<string, unknown> {
  return {
    code: appError.code,
    error: appError.message,
    ...appError.details,
    ...(appError.retriable === undefined ? {} : { retriable: appError.retriable }),
  };
}
