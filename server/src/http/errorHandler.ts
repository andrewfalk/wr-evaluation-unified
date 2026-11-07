// Central error handler (REFACTORING_ROADMAP S1 / P1-01). Registered last in createApp. Every error
// a route forwards (asyncHandler, or middleware calling next(err)) ends here: mapped by toAppError,
// answered as `{ code, error, ...details, requestId }`, and logged — 5xx as error with the cause,
// 4xx as warn. Request bodies are never logged.
import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../logger';
import { errorBody, toAppError } from './errors';

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express recognises an error handler by its four parameters — keep `_next`.
  return (err, req, res, _next) => {
    const appError = toAppError(err);
    const cause = appError.cause ?? err;
    const fields: Record<string, unknown> = {
      requestId: req.requestId,
      method: req.method,
      path: req.path, // without the query string
      status: appError.status,
      code: appError.code,
    };
    // Internal result-integrity failures: keep where the schema broke (path + issue code only —
    // `received` values could carry data).
    if (cause instanceof ZodError) fields.issues = cause.issues.map((i) => ({ path: i.path, code: i.code }));

    if (res.headersSent) {
      // Part of a response is already on the wire — a JSON body cannot follow. End the socket so
      // the client sees a broken response instead of a truncated one that looks complete.
      logger.error({ ...fields, err: cause, headersSent: true }, 'error after response started');
      res.destroy();
      return;
    }

    if (appError.status >= 500) logger.error({ ...fields, err: cause }, 'request failed');
    else logger.warn(fields, 'request rejected');

    res.status(appError.status).json({ ...errorBody(appError), requestId: req.requestId });
  };
}
