// M9 — read-only check that the database is in the role-separated state. cli/dbSetup.ts runs it last and exits 1
// on any violation, so `docker compose up` does not start the app on a database where the audit log could be
// changed by the app role, or where the app role could shadow a table by name.
import type { Pool, PoolClient } from 'pg';
import { APP_ROLE, MANAGED_ROLES, OWNER_ROLE, READER_ROLE, planGrants } from './policy';

type Db = Pick<Pool | PoolClient, 'query'>;

async function roleViolations(db: Db): Promise<string[]> {
  const out: string[] = [];
  const { rows } = await db.query<{
    rolname: string; rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean;
    rolreplication: boolean; rolbypassrls: boolean; rolcanlogin: boolean;
  }>(
    `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = ANY($1)`,
    [MANAGED_ROLES],
  );
  for (const role of MANAGED_ROLES) {
    const r = rows.find((row) => row.rolname === role);
    if (!r) {
      out.push(`role ${role} does not exist`);
      continue;
    }
    const bad = (['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolreplication', 'rolbypassrls'] as const)
      .filter((attr) => r[attr]);
    if (bad.length > 0) out.push(`role ${role} has ${bad.join(', ')}`);
    if (!r.rolcanlogin) out.push(`role ${role} cannot log in`);
  }
  const members = await db.query<{ role: string; member: string }>(
    `SELECT pg_get_userbyid(roleid) AS role, pg_get_userbyid(member) AS member FROM pg_auth_members
      WHERE pg_get_userbyid(roleid) = ANY($1) OR pg_get_userbyid(member) = ANY($1)`,
    [MANAGED_ROLES],
  );
  for (const m of members.rows) out.push(`role membership ${m.member} → ${m.role} (none allowed)`);
  return out;
}

async function databaseViolations(db: Db): Promise<string[]> {
  const out: string[] = [];
  const { rows: [d] } = await db.query<{ db: string; owner: string; schemaOwner: string | null }>(
    `SELECT current_database() AS db,
            (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()) AS owner,
            (SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname = 'public') AS "schemaOwner"`,
  );
  if (d.owner !== OWNER_ROLE) out.push(`database ${d.db} is owned by ${d.owner}, not ${OWNER_ROLE}`);
  if (d.schemaOwner !== 'pg_database_owner') out.push(`schema public is owned by ${d.schemaOwner ?? '(missing)'}, not pg_database_owner`);

  // PUBLIC is checked through the ACL (has_*_privilege takes a role); the two roles through has_*_privilege, so
  // a privilege held through PUBLIC counts too.
  const { rows: [pub] } = await db.query<{ dbCreate: boolean; dbTemp: boolean; schemaCreate: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM pg_database x, aclexplode(coalesce(x.datacl, acldefault('d', x.datdba))) a
                     WHERE x.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS "dbCreate",
            EXISTS (SELECT 1 FROM pg_database x, aclexplode(coalesce(x.datacl, acldefault('d', x.datdba))) a
                     WHERE x.datname = current_database() AND a.grantee = 0 AND a.privilege_type = 'TEMPORARY') AS "dbTemp",
            EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
                     WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'CREATE') AS "schemaCreate"`,
  );
  if (pub.dbCreate) out.push(`PUBLIC has CREATE on database ${d.db}`);
  if (pub.dbTemp) out.push(`PUBLIC has TEMPORARY on database ${d.db}`);
  if (pub.schemaCreate) out.push('PUBLIC has CREATE on schema public');

  for (const role of [APP_ROLE, READER_ROLE]) {
    const { rows: [p] } = await db.query<{ connect: boolean; create: boolean; temp: boolean; usage: boolean; schemaCreate: boolean }>(
      `SELECT has_database_privilege($1, current_database(), 'CONNECT') AS connect,
              has_database_privilege($1, current_database(), 'CREATE') AS create,
              has_database_privilege($1, current_database(), 'TEMPORARY') AS temp,
              has_schema_privilege($1, 'public', 'USAGE') AS usage,
              has_schema_privilege($1, 'public', 'CREATE') AS "schemaCreate"`,
      [role],
    );
    if (!p.connect) out.push(`${role} cannot CONNECT to database ${d.db}`);
    if (!p.usage) out.push(`${role} has no USAGE on schema public`);
    if (p.create) out.push(`${role} has CREATE on database ${d.db} (could create a schema)`);
    if (p.temp) out.push(`${role} has TEMPORARY on database ${d.db} (a temporary table would shadow a public one)`);
    if (p.schemaCreate) out.push(`${role} has CREATE on schema public`);
    // Any other schema it could create objects in (e.g. one named after the role: "$user" comes first in search_path).
    const other = await db.query<{ nspname: string }>(
      `SELECT nspname FROM pg_namespace
        WHERE nspname NOT IN ('public', 'information_schema') AND nspname NOT LIKE 'pg\\_%'
          AND has_schema_privilege($1, oid, 'CREATE')`,
      [role],
    );
    for (const s of other.rows) out.push(`${role} has CREATE on schema ${s.nspname}`);
  }
  return out;
}

async function ownershipViolations(db: Db): Promise<string[]> {
  // Every object in public that is not part of an extension. Row and array types of tables are included; they
  // follow their table's owner.
  const { rows } = await db.query<{ kind: string; name: string; owner: string }>(
    `WITH ext AS (SELECT classid, objid FROM pg_depend WHERE deptype = 'e')
     SELECT 'relation' AS kind, c.relname AS name, pg_get_userbyid(c.relowner) AS owner
       FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_class'::regclass AND ext.objid = c.oid)
     UNION ALL
     SELECT 'routine', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
       FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_proc'::regclass AND ext.objid = p.oid)
     UNION ALL
     SELECT 'type', t.typname, pg_get_userbyid(t.typowner)
       FROM pg_type t WHERE t.typnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_type'::regclass AND ext.objid = t.oid)
        AND NOT EXISTS (SELECT 1 FROM ext JOIN pg_type e ON ext.classid = 'pg_type'::regclass AND ext.objid = e.oid
                         WHERE e.oid = t.typelem OR e.typarray = t.oid)
     UNION ALL
     SELECT 'collation', c.collname, pg_get_userbyid(c.collowner)
       FROM pg_collation c WHERE c.collnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_collation'::regclass AND ext.objid = c.oid)
     UNION ALL
     SELECT 'operator', o.oprname, pg_get_userbyid(o.oprowner)
       FROM pg_operator o WHERE o.oprnamespace = 'public'::regnamespace
        AND NOT EXISTS (SELECT 1 FROM ext WHERE ext.classid = 'pg_operator'::regclass AND ext.objid = o.oid)
     UNION ALL
     SELECT 'statistics', s.stxname, pg_get_userbyid(s.stxowner)
       FROM pg_statistic_ext s WHERE s.stxnamespace = 'public'::regnamespace
     ORDER BY 1, 2`,
  );
  return rows.filter((r) => r.owner !== OWNER_ROLE).map((r) => `${r.kind} public.${r.name} is owned by ${r.owner}, not ${OWNER_ROLE}`);
}

async function auditLogViolations(db: Db): Promise<string[]> {
  const out: string[] = [];
  const triggers = await db.query<{ tgname: string; rel: string }>(
    `SELECT t.tgname, c.relname AS rel FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND (t.tgrelid = 'public.audit_logs'::regclass
             OR t.tgrelid IN (SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_logs'::regclass))`,
  );
  for (const t of triggers.rows) out.push(`trigger ${t.tgname} on ${t.rel} (audit_logs must have none)`);
  // Foreign keys in either direction: one referencing audit_logs could block or cascade into deletes elsewhere,
  // and one from audit_logs (or a partition) with ON DELETE / ON UPDATE CASCADE, SET NULL or SET DEFAULT would let
  // DML on an ordinary table change or remove audit rows through the internal FK triggers.
  const fks = await db.query<{ conname: string; rel: string; ref: string }>(
    `WITH audit AS (SELECT 'public.audit_logs'::regclass::oid AS oid
                    UNION SELECT inhrelid FROM pg_inherits WHERE inhparent = 'public.audit_logs'::regclass)
     SELECT conname, conrelid::regclass::text AS rel, confrelid::regclass::text AS ref FROM pg_constraint
      WHERE contype = 'f' AND (conrelid IN (SELECT oid FROM audit) OR confrelid IN (SELECT oid FROM audit))
      ORDER BY 1, 2`,
  );
  for (const f of fks.rows) out.push(`foreign key ${f.conname} on ${f.rel} → ${f.ref} touches audit_logs (none allowed)`);
  return out;
}

// A SECURITY DEFINER routine runs as its owner (wr_owner) for anyone allowed to EXECUTE it — PUBLIC by default —
// so one that deletes from audit_logs would undo the separation. None is allowed outside extensions.
async function securityDefinerViolations(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT p.oid::regprocedure::text AS name FROM pg_proc p
      WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef
        AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
      ORDER BY 1`,
  );
  return rows.map((r) => `routine public.${r.name} is SECURITY DEFINER (none allowed — it would run as ${OWNER_ROLE} for its callers)`);
}

/** Returns the violations (empty = role-separated). Reads the catalogs only; any role can run it. */
export async function verifyRoleSeparation(pool: Pool): Promise<string[]> {
  const out = [
    ...await roleViolations(pool), ...await databaseViolations(pool), ...await ownershipViolations(pool),
    ...await securityDefinerViolations(pool),
  ];

  const defaults = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM pg_default_acl');
  if (defaults.rows[0].n > 0) out.push(`pg_default_acl has ${defaults.rows[0].n} row(s) (default privileges are not used)`);

  const plan = await planGrants(pool);
  out.push(...plan.problems);
  for (const statement of plan.statements) out.push(`ACL differs from the policy: needs "${statement}"`);

  const hasAuditLogs = (await pool.query<{ ok: boolean }>("SELECT to_regclass('public.audit_logs') IS NOT NULL AS ok")).rows[0].ok;
  if (hasAuditLogs) out.push(...await auditLogViolations(pool));
  else out.push('table public.audit_logs does not exist');
  return out;
}
