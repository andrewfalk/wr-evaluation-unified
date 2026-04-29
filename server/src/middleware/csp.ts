import helmet from 'helmet';
import type { RequestHandler } from 'express';

// Content-Security-Policy for the API server.
//
// blob: in img-src/worker-src is needed for html2pdf/Excel export and image
// previews. style-src 'unsafe-inline' is temporary until CSS Variables /
// inline styles are cleaned up in the React app (Phase 6+ task).
// frame-ancestors 'none' prevents clickjacking.
export function cspMiddleware(): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc:      ["'self'"],
        connectSrc:      ["'self'"],
        scriptSrc:       ["'self'"],
        styleSrc:        ["'self'", "'unsafe-inline'"],
        imgSrc:          ["'self'", 'data:', 'blob:'],
        workerSrc:       ["'self'", 'blob:'],
        frameAncestors:  ["'none'"],
      },
    },
    // hsts, noSniff, xssFilter etc. are all enabled by helmet defaults
  });
}
