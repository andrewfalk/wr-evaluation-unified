// Server logger (REFACTORING_ROADMAP P1-01). One JSON object per line on stdout — no pretty
// transport in any environment; pipe to `npx pino-pretty` locally when a readable view is wanted.
// The access log is http/accessLog.ts (S9). The last console.* calls (db/client.ts and db/migrate.ts, reached by
// CLIs that do not load the full config, which this module does) move in S11.
//
// Errors are serialised by `serializeError`, not pino's default: a PostgreSQL error carries
// `detail` / `where` / `parameters`, and `detail` repeats the offending row values
// (`Key (patient_no)=(…) already exists`), which must not reach the log.
import pino, { type DestinationStream, type Logger } from 'pino';
import { ZodError } from 'zod';
import config from './config';

export type { Logger };

// Top-level and one level down (pino's `*` matches exactly one level).
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'password',
  'refreshToken',
  '*.password',
  '*.refreshToken',
];

// Keys copied from an Error. Everything else (pg `detail`, `where`, `parameters`, body-parser's
// raw `body`, arbitrary properties a library attached) is dropped. An error's own `type` property
// (body-parser: `entity.too.large`, `entity.parse.failed`) is kept as `errorType` so it does not
// overwrite the class name in `type`.
const ERROR_KEYS = ['code', 'constraint', 'table', 'column', 'routine', 'status'] as const;

function copyKeys(err: Error, out: Record<string, unknown>): Record<string, unknown> {
  const record = err as unknown as Record<string, unknown>;
  for (const key of ERROR_KEYS) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') out[key] = value;
  }
  if (typeof record.type === 'string') out.errorType = record.type;
  return out;
}

// Some error messages (and so the first part of their stack) repeat the input that failed:
// - a ZodError's message is the JSON of its issues (`received: …`);
// - a SyntaxError from JSON.parse — including body-parser's `entity.parse.failed` — quotes the
//   request body (`"{"password":…" is not valid JSON`);
// - a PostgreSQL error message quotes the offending value (22P02
//   `invalid input syntax for type uuid: "…"`).
// For those keep a fixed message and only the call frames that come AFTER the original message
// in the stack: the quoted input can itself contain lines that look like "    at …", so frames
// are never searched for inside the message. If the message cannot be located, drop the stack.
function framesAfterMessage(err: Error): string[] {
  const stack = err.stack ?? '';
  const at = err.message ? stack.indexOf(err.message) : -1;
  if (at < 0) return [];
  return stack.slice(at + err.message.length).split('\n').filter((line) => /^\s+at /.test(line));
}

function withFixedMessage(err: Error, message: string): Record<string, unknown> {
  const frames = framesAfterMessage(err);
  return copyKeys(err, { type: err.name, message, stack: [`${err.name}: ${message}`, ...frames].join('\n') });
}

// pg's DatabaseError (pg-protocol) — matched by shape, not class: pg-protocol is not a direct
// dependency. Every server error carries a severity and a five-character SQLSTATE code.
function isPostgresError(err: Error): err is Error & { code: string } {
  const record = err as unknown as Record<string, unknown>;
  return typeof record.severity === 'string' && typeof record.code === 'string' && /^[0-9A-Z]{5}$/.test(record.code);
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof ZodError) return withFixedMessage(err, `${err.issues.length} validation issue(s)`);
  if (err instanceof SyntaxError) return withFixedMessage(err, 'invalid JSON');
  if (!(err instanceof Error)) return { type: typeof err };
  if (isPostgresError(err)) return withFixedMessage(err, `PostgreSQL error ${err.code}`);
  return copyKeys(err, { type: err.name, message: err.message, stack: err.stack });
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
