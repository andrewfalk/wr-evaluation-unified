// Request id (REFACTORING_ROADMAP S1 / P1-01). Adopts a well-formed incoming `X-Request-Id`
// (e.g. set by the reverse proxy) and otherwise generates a UUID. The id is echoed in the
// `X-Request-Id` response header, added to error envelopes and to error log lines, so a user's
// report ("요청 ID …") can be matched to the server log.
import { randomUUID } from 'crypto';
import type { RequestHandler } from 'express';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const VALID_REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

export function requestIdMiddleware(): RequestHandler {
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming && VALID_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    req.requestId = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}
