// 라우터 단위 테스트용 Express 앱 (REFACTORING_ROADMAP P0-11).
// 기존 라우트 테스트의 `makeApp`(express + json + cookieParser + 라우터 1개)과 같은 모양.
//
//   const app = makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));
//
// 보안 헤더·CORS·no-store·정적 SPA까지 포함한 전체 앱이 필요하면 `createApp({ pool, auditPool })`
// (`src/app.ts`)을 그대로 쓴다 — fakePool의 `pool`을 두 인자 모두에 넘길 수 있다.
//
// 마운트 뒤에 실제 앱과 같은 중앙 에러 처리기(http/errorHandler.ts, 로그 silent)를 붙인다 —
// 핸들러가 던진 오류가 Express 기본 HTML 500이 아니라 운영과 같은 JSON 응답이 되도록(S1).
// 요청 ID 미들웨어는 붙이지 않으므로 오류 본문의 requestId는 undefined(JSON에서 빠짐).

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';
import { createErrorHandler } from '../http/errorHandler';
import { createLogger } from '../logger';

export interface RouterAppOptions {
  /** express.json 본문 상한. 기본은 express 기본값(100kb). */
  jsonLimit?: string;
}

export function makeRouterApp(mount: (app: Express) => void, options: RouterAppOptions = {}): Express {
  const app = express();
  app.use(express.json(options.jsonLimit ? { limit: options.jsonLimit } : undefined));
  app.use(cookieParser());
  mount(app);
  app.use(createErrorHandler(createLogger({ level: 'silent' })));
  return app;
}
