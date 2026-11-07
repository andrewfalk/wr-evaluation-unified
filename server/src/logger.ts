// Server logger (REFACTORING_ROADMAP P1-01). One JSON object per line on stdout — no pretty
// transport in any environment; pipe to `npx pino-pretty` locally when a readable view is wanted.
// The access log (pino-http) arrives in S9 and the remaining console.* calls move here in S9/S11.
//
// Errors are serialised by `serializeError`, not pino's default: a PostgreSQL error carries
// `detail` / `where` / `parameters`, and `detail` repeats the offending row values
// (`Key (patient_no)=(…) already exists`), which must not reach the log.
import pino, { type DestinationStream, type Logger } from 'pino';
import config from './config';

export type { Logger };

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.refreshToken',
];

// Keys copied from an Error. Everything else (pg `detail`, `where`, `parameters`, arbitrary
// properties a library attached) is dropped.
const ERROR_KEYS = ['code', 'constraint', 'table', 'column', 'routine', 'status', 'type'] as const;

export function serializeError(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { type: typeof err };
  const out: Record<string, unknown> = { type: err.name, message: err.message, stack: err.stack };
  const record = err as unknown as Record<string, unknown>;
  for (const key of ERROR_KEYS) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  return out;
}

export interface CreateLoggerOptions {
  level?: string;
}

export function createLogger(options: CreateLoggerOptions = {}, destination?: DestinationStream): Logger {
  return pino(
    {
      // Config mocks in older route tests have no `log` key — fall back instead of throwing.
      level: options.level ?? config.log?.level ?? 'info',
      base: { service: 'wr-app-server' },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      serializers: { err: serializeError },
    },
    destination,
  );
}

export const logger: Logger = createLogger();
export default logger;
