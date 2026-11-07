// asyncHandler (REFACTORING_ROADMAP S1 / P1-01). Express 4 does not catch a rejected promise from a
// handler, so routes used to append `.catch(() => res.status(500).json(internalError()))` — which
// also swallowed the error without a log line. This forwards the rejection to the central error
// handler (`createErrorHandler`) instead, which maps it (`toAppError`) and logs it.
//
// Existing handlers keep their `(pool, req, res)` signature; routers wrap them:
//   router.get('/', auth, asyncHandler((req, res) => listPatients(pool, req, res)));
import type { NextFunction, Request, RequestHandler, Response } from 'express';

export type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => unknown;

export function asyncHandler(fn: AsyncRequestHandler): RequestHandler {
  return (req, res, next) => {
    // Promise.resolve(...) inside a try: a synchronous throw from `fn` is forwarded too.
    let result: unknown;
    try {
      result = fn(req, res, next);
    } catch (err) {
      next(err);
      return;
    }
    Promise.resolve(result).catch(next);
  };
}
