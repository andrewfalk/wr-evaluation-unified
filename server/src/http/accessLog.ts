// Access log (REFACTORING_ROADMAP S9 / P1-d): one line per finished request — method, path, status, duration and the
// request id (http/requestId.ts, so a user's "요청 ID" matches the line). Nothing else from the request is logged: no
// query string (search terms, ids), no headers (authorization, cookies), no body. /health (the container
// healthcheck, every 30 s) is not logged. Level: 5xx error, 4xx warn, else info.
import type { IncomingMessage, ServerResponse } from 'http';
import type { Request, RequestHandler } from 'express';
import pinoHttp from 'pino-http';
import type { Logger } from '../logger';

function pathOf(req: IncomingMessage): string {
  const url = (req as Request).originalUrl ?? req.url ?? '';
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

export function accessLogMiddleware(logger: Logger): RequestHandler {
  return pinoHttp({
    logger,
    // requestIdMiddleware runs first and sets it; pino-http then logs it as req.id.
    genReqId: (req) => (req as Request).requestId ?? 'unknown',
    autoLogging: { ignore: (req) => pathOf(req) === '/health' },
    // The raw objects in, only these fields out.
    wrapSerializers: false,
    serializers: {
      req: (req: IncomingMessage & { id?: unknown }) => ({ id: req.id, method: req.method, path: pathOf(req) }),
      res: (res: ServerResponse) => ({ statusCode: res.statusCode }),
      // The central error handler (http/errorHandler.ts) logs the error itself, with its redaction rules.
      err: () => undefined,
    },
    customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
    // One message for every status (the level carries the severity); 'request failed' is the error handler's line.
    customSuccessMessage: () => 'request completed',
    customErrorMessage: () => 'request completed',
    // No per-request child logger noise: only the completion line.
    quietReqLogger: true,
  }) as unknown as RequestHandler;
}
