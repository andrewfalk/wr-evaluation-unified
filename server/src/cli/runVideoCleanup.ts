import { pool } from '../db/client';
import { runVideoClipCleanup } from '../jobs/videoClipCleanup';

runVideoClipCleanup(pool)
  .then(({ clipsExpired, originalsDeleted, artifactsDeleted, orphansDeleted }) => {
    console.log(`[video-cleanup] clips=${clipsExpired} originals=${originalsDeleted} artifacts=${artifactsDeleted} orphans=${orphansDeleted}`);
    pool.end();
  })
  .catch((err) => {
    console.error('[video-cleanup] error', err);
    pool.end();
    process.exit(1);
  });
