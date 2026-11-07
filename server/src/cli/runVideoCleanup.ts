import { createPool } from '../db/client';
import { runVideoClipCleanup } from '../jobs/videoClipCleanup';

const pool = createPool(process.env.DATABASE_URL);

runVideoClipCleanup(pool)
  .then(({ clipsExpired, originalsDeleted, artifactsDeleted, sampleFramesDeleted, orphansDeleted }) => {
    console.log(`[video-cleanup] clips=${clipsExpired} originals=${originalsDeleted} artifacts=${artifactsDeleted} frames=${sampleFramesDeleted} orphans=${orphansDeleted}`);
    pool.end();
  })
  .catch((err) => {
    console.error('[video-cleanup] error', err);
    pool.end();
    process.exit(1);
  });
