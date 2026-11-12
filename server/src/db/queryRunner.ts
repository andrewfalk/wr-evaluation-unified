// The minimal query surface shared by the patient write paths (S7). Moved from db/patientPersons.ts,
// which re-exports it, so existing imports keep working.
import type { Pool, PoolClient } from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface QueryRunner {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

/**
 * A pg `Pool` or `PoolClient` as a `QueryRunner`. Both are assignable without a cast (checked with tsc
 * in S7-0); call sites use this instead of `as unknown as QueryRunner`.
 */
export function toQueryRunner(db: Pool | PoolClient): QueryRunner {
  return db;
}
