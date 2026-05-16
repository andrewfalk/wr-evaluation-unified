import { pool } from '../db/client';
import { runWorkspaceRetention } from '../jobs/workspaceRetention';

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
