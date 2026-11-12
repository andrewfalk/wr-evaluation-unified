// The server entry point (`npm run dev` / `node dist/index.js`). Startup, background jobs and the graceful stop live in
// src/boot.ts (S9); the app itself is src/app.ts (REFACTORING_ROADMAP P0-3).
import { main } from './boot';

if (require.main === module) {
  main().catch((err) => {
    console.error('[wr-server] startup failed', err);
    process.exit(1);
  });
}
