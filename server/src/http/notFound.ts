// JSON 404 for unknown /api paths (REFACTORING_ROADMAP S1 / P1-01). Registered after every API
// router and before /updates and the SPA, so an unknown API path answers JSON instead of Express's
// default HTML "Cannot GET …" page.
import type { RequestHandler } from 'express';

export function apiNotFound(): RequestHandler {
  return (req, res) => {
    res.status(404).json({ code: 'NOT_FOUND', error: 'Not found', requestId: req.requestId });
  };
}
