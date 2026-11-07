import { createPool } from '../db/client';
import { runStatsRunCleanup } from '../jobs/statsRunCleanup';

const pool = createPool(process.env.DATABASE_URL);

runStatsRunCleanup(pool)
  .then(({ deleted }) => {
    console.log(`[stats-run-cleanup] deleted=${deleted}`);
    pool.end();
  })
  .catch((err) => {
    console.error('[stats-run-cleanup] error', err);
    pool.end();
    process.exit(1);
  });
