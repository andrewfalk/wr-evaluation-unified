import { createPool } from '../db/client';
import { parseRetentionArgs, runRetentionCommand } from './retentionCommand';

const args = parseRetentionArgs(process.argv.slice(2), process.env.NODE_ENV);
if ('error' in args) {
  console.error(`[retention] ${args.error}`);
  process.exit(2);
}

const pool = createPool(process.env.DATABASE_URL);

runRetentionCommand(pool, args, (line) => console.log(line))
  .then(() => {
    pool.end();
  })
  .catch((err) => {
    console.error('[retention] error', err);
    pool.end();
    process.exit(1);
  });
