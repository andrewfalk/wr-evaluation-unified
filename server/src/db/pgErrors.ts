// PostgreSQL error shapes the patient write paths check (S7-3). Moved from routes/patients/{schemas,shared}.ts,
// which re-export them.

export interface PgErrorLike {
  code?:       string;
  constraint?: string;
}

export function isUniqueViolation(err: unknown): err is PgErrorLike {
  return (err as PgErrorLike | null)?.code === '23505';
}
