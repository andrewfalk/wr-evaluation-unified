// 라우터 단위 테스트용 Express 앱 (REFACTORING_ROADMAP P0-11).
// 기존 라우트 테스트의 `makeApp`(express + json + cookieParser + 라우터 1개)과 같은 모양.
//
//   const app = makeRouterApp(a => a.use('/api/presets', createPresetsRouter(fake.pool)));
//
// 보안 헤더·CORS·no-store·정적 SPA까지 포함한 전체 앱이 필요하면 `createApp({ pool, auditPool })`
// (`src/app.ts`)을 그대로 쓴다 — fakePool의 `pool`을 두 인자 모두에 넘길 수 있다.

import express, { type Express } from 'express';
import cookieParser from 'cookie-parser';

export interface RouterAppOptions {
  /** express.json 본문 상한. 기본은 express 기본값(100kb). */
  jsonLimit?: string;
}

export function makeRouterApp(mount: (app: Express) => void, options: RouterAppOptions = {}): Express {
  const app = express();
  app.use(express.json(options.jsonLimit ? { limit: options.jsonLimit } : undefined));
  app.use(cookieParser());
  mount(app);
  return app;
}
