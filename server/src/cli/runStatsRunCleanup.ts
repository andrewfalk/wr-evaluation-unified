import { createPool } from '../db/client';
import { runStatsRunCleanup } from '../jobs/statsRunCleanup';

const pool = createPool(process.env.DATABASE_URL);
// S8: the same namespace the server uses (QUEUE_NAMESPACE, default 'default'); this CLI does not load the full config.
const queueNamespace = process.env.QUEUE_NAMESPACE || 'default';

runStatsRunCleanup(pool, queueNamespace)
  .then(({ deleted }) => {
    console.log(`[stats-run-cleanup] namespace=${queueNamespace} deleted=${deleted}`);
    pool.end();
  })
  .catch((err) => {
    console.error('[stats-run-cleanup] error', err);
    pool.end();
    process.exit(1);
  });
