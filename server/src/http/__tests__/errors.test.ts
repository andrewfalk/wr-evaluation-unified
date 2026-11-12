// toAppError mapping table (REFACTORING_ROADMAP P1-01). Each domain row must equal the response the
// route handler already sends from its own catch block (routes/patients.ts) — S7 relies on that.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AppError, errorBody, toAppError } from '../errors';
import { logger } from '../../logger';
import {
  IdentityCaseLockedError,
  IdentityForbiddenError,
  IdentityRevisionMismatchError,
  IdentitySetChangedError,
  IdentityTargetNotFoundError,
} from '../../db/patientIdentityCorrection';
import { PatientLockForbiddenError, PatientLockTargetNotFoundError } from '../../db/patientLocks';
import { PatientIdentityConflictError, PatientPersonVanishedError } from '../../db/patientPersons';
import {
  StatsEngineBusyError,
  StatsEngineCancelledError,
  StatsEngineDegradedError,
  StatsEngineInputTooLargeError,
  StatsEngineOutputTooLargeError,
  StatsEngineProcessError,
  StatsEngineResultInvalidError,
  StatsEngineTimeoutError,
} from '../../stats/engine';

const INTERNAL = { code: 'INTERNAL_ERROR', error: 'Internal server error' };
const ASSIGNED_ONLY = { code: 'FORBIDDEN', error: 'Only the assigned doctor can modify this patient' };

function mapped(err: unknown) {
  const appError = toAppError(err);
  return { status: appError.status, body: errorBody(appError) };
}

function pgError(code: string, extra: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(`pg ${code}`), { code, severity: 'ERROR', ...extra });
}

describe('toAppError — domain errors keep the handlers\' responses', () => {
  it.each<[string, unknown, number, Record<string, unknown>]>([
    ['PatientLockTargetNotFoundError', new PatientLockTargetNotFoundError(), 404, { code: 'PATIENT_NOT_FOUND', error: 'Patient not found' }],
    ['IdentityTargetNotFoundError', new IdentityTargetNotFoundError(), 404, { code: 'PATIENT_NOT_FOUND', error: 'Patient not found' }],
    ['PatientLockForbiddenError', new PatientLockForbiddenError(), 403, ASSIGNED_ONLY],
    ['IdentityRevisionMismatchError', new IdentityRevisionMismatchError(7), 409, { code: 'CONFLICT', error: 'Revision mismatch.', currentRevision: 7 }],
    ['IdentityForbiddenError (assigned doctor)', new IdentityForbiddenError(false), 403, ASSIGNED_ONLY],
    ['IdentityForbiddenError (requires admin)', new IdentityForbiddenError(true), 403, {
      code: 'IDENTITY_CORRECTION_REQUIRES_ADMIN',
      error: 'This patient number has multiple active cases; only an administrator can correct it',
    }],
    ['IdentityCaseLockedError', new IdentityCaseLockedError('김의사'), 423, { code: 'LOCK_HELD', error: 'A related case is being edited by 김의사' }],
    ['IdentitySetChangedError', new IdentitySetChangedError(), 409, {
      code: 'IDENTITY_SET_CHANGED',
      error: 'Related cases kept changing while applying the correction. Please retry.',
      retriable: true,
    }],
    ['PatientIdentityConflictError', new PatientIdentityConflictError(), 409, {
      code: 'PATIENT_IDENTITY_CONFLICT',
      error: 'This patient number belongs to an existing patient with a different birth date',
    }],
    ['PatientPersonVanishedError', new PatientPersonVanishedError(), 409, {
      code: 'PATIENT_PERSON_VANISHED',
      error: 'The patient identity was modified concurrently. Please retry.',
      retriable: true,
    }],
  ])('%s', (_name, err, status, body) => {
    expect(mapped(err)).toEqual({ status, body });
  });
});

describe('toAppError — stats engine errors use statsEngineErrorMapping', () => {
  it.each<[string, unknown, number, Record<string, unknown>]>([
    ['busy', new StatsEngineBusyError(), 429, { code: 'ENGINE_BUSY', error: 'Analysis engine is busy — please retry shortly.' }],
    ['degraded', new StatsEngineDegradedError(), 503, { code: 'ENGINE_DEGRADED', error: 'Analysis engine is temporarily unavailable.' }],
    ['input too large', new StatsEngineInputTooLargeError('n'), 400, {
      code: 'INPUT_TOO_LARGE', error: 'The recipe exceeds the supported size for statistical analysis.',
    }],
    ['timeout', new StatsEngineTimeoutError(), 500, { code: 'TIMEOUT', error: 'Analysis timed out.' }],
    ['output too large', new StatsEngineOutputTooLargeError(), 500, { code: 'OUTPUT_TOO_LARGE', error: 'Analysis output exceeded the supported size.' }],
    ['result invalid', new StatsEngineResultInvalidError('x'), 500, {
      code: 'RESULT_SCHEMA_INVALID', error: 'Analysis engine returned a result that failed validation.',
    }],
    ['invalid output', new StatsEngineProcessError('INVALID_OUTPUT', 'x'), 500, { code: 'INVALID_OUTPUT', error: 'Analysis engine returned invalid output.' }],
    ['process error', new StatsEngineProcessError('PROCESS_ERROR', '/opt/secret/path'), 500, {
      code: 'PROCESS_ERROR', error: 'Analysis engine failed to complete.',
    }],
    ['cancelled', new StatsEngineCancelledError(), 500, { code: 'PROCESS_ERROR', error: 'Analysis engine failed to complete.' }],
  ])('%s', (_name, err, status, body) => {
    const spy = vi.spyOn(logger, 'error').mockImplementation(() => {}); // errorBodyFor logs the detail
    try {
      expect(mapped(err)).toEqual({ status, body });
    } finally {
      spy.mockRestore();
    }
  });
});

describe('toAppError — other errors', () => {
  it('passes an AppError through unchanged', () => {
    const err = new AppError(422, 'SOMETHING', 'msg', { extra: 1 });
    expect(toAppError(err)).toBe(err);
    expect(errorBody(err)).toEqual({ code: 'SOMETHING', error: 'msg', extra: 1 });
  });

  it('body-parser entity.too.large → 413 PAYLOAD_TOO_LARGE (unchanged from before S1)', () => {
    const err = Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413, limit: 10 });
    expect(mapped(err)).toEqual({ status: 413, body: { code: 'PAYLOAD_TOO_LARGE', error: 'Request body is too large' } });
  });

  it('body-parser entity.parse.failed stays 500 (unchanged from before S1)', () => {
    const err = Object.assign(new SyntaxError('Unexpected token'), { type: 'entity.parse.failed', status: 400 });
    expect(mapped(err)).toEqual({ status: 500, body: INTERNAL });
  });

  it('pg 23505 → 409 UNIQUE_VIOLATION with the constraint name, without pg detail values', () => {
    const err = pgError('23505', { constraint: 'users_login_id_key', detail: 'Key (login_id)=(secret-login) already exists.' });
    const result = mapped(err);
    expect(result).toEqual({ status: 409, body: { code: 'UNIQUE_VIOLATION', error: 'Resource already exists', constraint: 'users_login_id_key' } });
    expect(JSON.stringify(result)).not.toContain('secret-login');
  });

  it('pg 40P01 (deadlock) → 500, not retried here', () => {
    expect(mapped(pgError('40P01'))).toEqual({ status: 500, body: INTERNAL });
  });

  it('a ZodError (internal .parse() integrity check) → 500, never 400 with issues', () => {
    const result = z.object({ a: z.string() }).strict().safeParse({ a: 1, extra: true });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(mapped(result.error)).toEqual({ status: 500, body: INTERNAL });
  });

  it.each([
    ['a plain Error', new Error('boom: /var/lib/secret')],
    ['a thrown string', 'boom'],
    ['undefined', undefined],
    ['an object with a numeric code', Object.assign(new Error('x'), { code: 23505 })],
  ])('%s → 500 INTERNAL_ERROR with no message leak', (_name, err) => {
    expect(mapped(err)).toEqual({ status: 500, body: INTERNAL });
  });

  it('keeps the original error as cause for logging', () => {
    const original = new Error('boom');
    expect(toAppError(original).cause).toBe(original);
  });
});
