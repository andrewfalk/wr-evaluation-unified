import { createPool } from '../db/client';
import { runWorkspaceRetention } from '../jobs/workspaceRetention';

const pool = createPool(process.env.DATABASE_URL);

runWorkspaceRetention(pool)
  .then(({ deleted }) => {
    console.log(`[retention] deleted ${deleted} expired workspace(s)`);
    pool.end();
  })
  .catch((err) => {
    console.error('[retention] error', err);
    pool.end();
    process.exit(1);
  });
