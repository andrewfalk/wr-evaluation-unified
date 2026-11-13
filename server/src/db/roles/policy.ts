// M9 — database role separation: the roles and the grant policy that applyGrants applies and
// verifyRoleSeparation checks (REFACTORING_ROADMAP M9).
//
//   wr_user (bootstrap superuser) — prepares the roles (bootstrapRoles), backup, restore, operator psql
//   wr_owner — owns the database and every object in public; runs the migrations and the partition sidecar
//   wr_app   — the server at run time: DML only, audit_logs INSERT only, owns nothing, member of nothing
//   wr_audit_reader — the audit read pool: SELECT on audit_logs only (created by migration 0004)
//
// No ALTER DEFAULT PRIVILEGES: a default would give wr_app DML on every monthly audit_logs_YYYY_MM partition the
// sidecar creates, and writing a partition directly bypasses the parent's ACL. Instead applyGrants brings the ACL
// of every object in public to this table after each migration run.
import type { PoolClient } from 'pg';

export const OWNER_ROLE = 'wr_owner';
export const APP_ROLE = 'wr_app';
export const READER_ROLE = 'wr_audit_reader';
export const MANAGED_ROLES = [OWNER_ROLE, APP_ROLE, READER_ROLE] as const;
export type ManagedRole = (typeof MANAGED_ROLES)[number];

/** A grantee in the policy: one of the two roles without ownership, or PUBLIC. */
export type PolicyGrantee = typeof APP_ROLE | typeof READER_ROLE | 'PUBLIC';

/** One relation in schema public that is not part of an extension. */
export interface ManagedRelation {
  name: string;
  relkind: string;
  isPartition: boolean;
  owner: string;
}

const TABLE_DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/**
 * The privileges each grantee should hold on `rel` (grantees not listed: none), or null when there is no
 * policy for this kind of relation — a new view, materialized view, foreign table or composite type makes
 * applyGrants and verifyRoleSeparation fail, so someone decides its policy instead of it being guessed.
 */
export function policyFor(rel: ManagedRelation): Map<PolicyGrantee, string[]> | null {
  if (rel.relkind === 'S') return new Map([[APP_ROLE, ['USAGE']]]);
  if (rel.relkind !== 'r' && rel.relkind !== 'p') return null;
  // Partitions: nothing. Rows reach them through the parent, whose ACL is the one checked.
  if (rel.isPartition) return new Map();
  if (rel.name === 'audit_logs') return new Map([[APP_ROLE, ['INSERT']], [READER_ROLE, ['SELECT']]]);
  if (rel.name === 'schema_migrations') return new Map([[APP_ROLE, ['SELECT']]]);
  return new Map([[APP_ROLE, TABLE_DML]]);
}

// Relations of schema public that the policy covers: every relkind that carries an ACL, without the members of
// an extension (pg_trgm's objects belong to the extension, not to the application).
export const MANAGED_RELATIONS_SQL = `
  SELECT c.relname AS name, c.relkind::text AS relkind, c.relispartition AS "isPartition",
         pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f', 'c')
     AND NOT EXISTS (SELECT 1 FROM pg_depend d
                      WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
   ORDER BY c.relname`;

export async function listManagedRelations(client: Pick<PoolClient, 'query'>): Promise<ManagedRelation[]> {
  return (await client.query<ManagedRelation>(MANAGED_RELATIONS_SQL)).rows;
}

interface AclEntry {
  name: string;
  grantee: string;
  privilege: string;
  grantable: boolean;
}

/** Explicit privileges on the managed relations held by anyone other than the owner (PUBLIC as 'PUBLIC'). */
async function listGrants(client: Pick<PoolClient, 'query'>): Promise<AclEntry[]> {
  return (await client.query<AclEntry>(`
    SELECT c.relname AS name,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_class c, aclexplode(c.relacl) a
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f', 'c')
       AND a.grantee <> c.relowner
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')`)).rows;
}

interface ColumnAclEntry extends AclEntry {
  column: string;
}

/**
 * Column-level privileges (pg_attribute.attacl) on the managed relations. The policy grants none: a column grant
 * such as `GRANT UPDATE (action) ON audit_logs` would let a role change audit rows while the table ACL looks right.
 */
async function listColumnGrants(client: Pick<PoolClient, 'query'>): Promise<ColumnAclEntry[]> {
  return (await client.query<ColumnAclEntry>(`
    SELECT c.relname AS name, att.attname AS column,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type AS privilege, a.is_grantable AS grantable
      FROM pg_class c
      JOIN pg_attribute att ON att.attrelid = c.oid AND att.attnum > 0 AND NOT att.attisdropped
     CROSS JOIN aclexplode(att.attacl) a
     WHERE c.relnamespace = 'public'::regnamespace
       AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f', 'c')
       AND a.grantee <> c.relowner
       AND NOT EXISTS (SELECT 1 FROM pg_depend d
                        WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'e')
     ORDER BY 1, 2, 3, 4`)).rows;
}

export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function granteeSql(grantee: string): string {
  return grantee === 'PUBLIC' ? 'PUBLIC' : quoteIdent(grantee);
}

export interface GrantPlan {
  /** GRANT / REVOKE statements that bring the ACL to the policy (empty when it already matches). */
  statements: string[];
  /** Relations the policy cannot handle: not owned by wr_owner, or no policy for their kind. */
  problems: string[];
}

/** Compares the ACL of every managed relation with the policy. Reads only. */
export async function planGrants(client: Pick<PoolClient, 'query'>): Promise<GrantPlan> {
  const relations = await listManagedRelations(client);
  const grants = await listGrants(client);
  const columnGrants = await listColumnGrants(client);
  const statements: string[] = [];
  const problems: string[] = [];

  for (const rel of relations) {
    if (rel.owner !== OWNER_ROLE) {
      problems.push(`public.${rel.name} is owned by ${rel.owner}, not ${OWNER_ROLE}`);
      continue;
    }
    const policy = policyFor(rel);
    if (!policy) {
      problems.push(`public.${rel.name} (relkind '${rel.relkind}') has no grant policy — add one to db/roles/policy.ts`);
      continue;
    }
    const target = `${rel.relkind === 'S' ? 'SEQUENCE' : 'TABLE'} public.${quoteIdent(rel.name)}`;
    const held = grants.filter((g) => g.name === rel.name);
    const grantees = new Set<string>([...policy.keys(), ...held.map((g) => g.grantee)]);
    for (const grantee of [...grantees].sort()) {
      const want = new Set(policy.get(grantee as PolicyGrantee) ?? []);
      const have = held.filter((g) => g.grantee === grantee);
      const haveSet = new Set(have.map((g) => g.privilege));
      const toGrant = [...want].filter((p) => !haveSet.has(p)).sort();
      const toRevoke = [...haveSet].filter((p) => !want.has(p)).sort();
      const toUngrantable = have.filter((g) => g.grantable && want.has(g.privilege)).map((g) => g.privilege).sort();
      if (toRevoke.length > 0) statements.push(`REVOKE ${toRevoke.join(', ')} ON ${target} FROM ${granteeSql(grantee)}`);
      if (toUngrantable.length > 0) {
        statements.push(`REVOKE GRANT OPTION FOR ${toUngrantable.join(', ')} ON ${target} FROM ${granteeSql(grantee)}`);
      }
      if (toGrant.length > 0) statements.push(`GRANT ${toGrant.join(', ')} ON ${target} TO ${granteeSql(grantee)}`);
    }
    // Column privileges: none allowed. One REVOKE per grantee and privilege, listing its columns.
    const byGrant = new Map<string, string[]>();
    for (const g of columnGrants.filter((x) => x.name === rel.name)) {
      const key = `${g.grantee}\u0000${g.privilege}`;
      const cols = byGrant.get(key) ?? [];
      if (!cols.includes(g.column)) cols.push(g.column);
      byGrant.set(key, cols);
    }
    for (const [key, cols] of byGrant) {
      const [grantee, privilege] = key.split('\u0000');
      statements.push(`REVOKE ${privilege} (${cols.map(quoteIdent).join(', ')}) ON ${target} FROM ${granteeSql(grantee)}`);
    }
  }
  return { statements, problems };
}
