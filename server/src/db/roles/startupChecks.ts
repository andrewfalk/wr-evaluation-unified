// M9 — checks the server runs before it accepts requests (boot.ts). Each throws StartupCheckError; the server logs
// it and exits 1, and the container's restart policy tries again (after a reboot Docker does not wait for the
// one-shot migrate service, so this self-check is the safety net).
import type { Pool } from 'pg';

export class StartupCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupCheckError';
  }
}

const RUN_MIGRATE =
  'Run the database setup (`docker compose -f docker-compose.yml -f docker-compose.prod.yml run --rm migrate`, ' +
  'or plain `docker compose up -d`, which runs it first), then start the server again.';

/**
 * Refuses to start when DATABASE_URL's role could change or remove audit rows: a superuser, a member of the role
 * that owns audit_logs, or a role with UPDATE / DELETE / TRUNCATE on it. Used when AUTO_MIGRATE=false — the
 * role-separated deployment, where the server must run as wr_app.
 */
export async function assertLeastPrivilege(pool: Pool): Promise<void> {
  const { rows: [r] } = await pool.query<{
    role: string; superuser: boolean; owner: boolean; update: boolean; delete: boolean; truncate: boolean;
  }>(
    `SELECT current_user AS role,
            (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
            pg_has_role(current_user, c.relowner, 'MEMBER') AS owner,
            has_table_privilege(current_user, c.oid, 'UPDATE') AS update,
            has_table_privilege(current_user, c.oid, 'DELETE') AS delete,
            has_table_privilege(current_user, c.oid, 'TRUNCATE') AS truncate
       FROM pg_class c WHERE c.oid = 'public.audit_logs'::regclass`,
  );
  const why = [
    r.superuser && 'is a superuser',
    r.owner && 'owns audit_logs',
    r.update && 'can UPDATE audit_logs',
    r.delete && 'can DELETE from audit_logs',
    r.truncate && 'can TRUNCATE audit_logs',
  ].filter(Boolean);
  if (why.length > 0) {
    throw new StartupCheckError(
      `[wr-server] DATABASE_URL connects as ${r.role}, which ${why.join(', ')}. With AUTO_MIGRATE=false ` +
      '(the default under NODE_ENV=production) the server runs as the app role wr_app — point DATABASE_URL at ' +
      `wr_app (APP_DB_PASSWORD), or run the database setup if wr_app still has these rights. ${RUN_MIGRATE}`,
    );
  }
}

/**
 * Refuses to start when DATABASE_URL's role cannot write audit rows (INSERT on audit_logs and USAGE on its id
 * sequence). The audit writer swallows errors so a request never fails on it — without this check the server
 * would run and silently lose its audit trail. Always true for a superuser.
 */
export async function assertAuditWritable(pool: Pool): Promise<void> {
  const { rows: [r] } = await pool.query<{ role: string; insert: boolean; sequence: boolean }>(
    `SELECT current_user AS role,
            has_table_privilege(current_user, 'public.audit_logs', 'INSERT') AS insert,
            has_sequence_privilege(current_user, 'public.audit_logs_id_seq', 'USAGE') AS sequence`,
  );
  const missing = [!r.insert && 'INSERT on audit_logs', !r.sequence && 'USAGE on audit_logs_id_seq'].filter(Boolean);
  if (missing.length > 0) {
    throw new StartupCheckError(
      `[wr-server] DATABASE_URL connects as ${r.role}, which lacks ${missing.join(' and ')} — audit rows would be ` +
      `lost. ${RUN_MIGRATE}`,
    );
  }
}
