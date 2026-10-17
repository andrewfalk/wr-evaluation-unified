import helmet from 'helmet';
import type { RequestHandler } from 'express';

// HF4(L7): /api 응답은 환자 PHI를 담을 수 있으므로 브라우저·프록시 디스크 캐시에 남기지 않는다.
// 라우트가 더 구체적인 Cache-Control을 따로 정하면(config.ts는 'no-store', videoAnalysis.ts는 'no-store, private')
// 이 미들웨어가 먼저 실행되고 라우트가 나중에 덮어쓰므로 그쪽이 이긴다. ETag는 그대로 둔다 — 앱의
// If-Match는 정수 revision이라 Express ETag와 무관하다. 정적 SPA 자산·/health·/updates는 /api 밖이라 영향이 없다.
export function noStoreMiddleware(): RequestHandler {
  return (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  };
}

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
