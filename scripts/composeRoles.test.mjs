import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// M9(7.3.0) 역할 분리 compose 불변식. 운영은 docker-compose.yml + docker-compose.prod.yml 로 뜬다(Compose v2.22.0 —
// `!override` 무시, `!reset` 동작). 1회성 migrate 서비스가 역할·마이그레이션·권한을 준비하고, app 은 wr_app, partition
// 사이드카는 wr_owner, backup 은 그대로 부트스트랩 슈퍼유저 wr_user 로 접속한다.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const tag = (name, kind) => new yaml.Type(name, { kind, construct: (v) => ({ [`$${name.slice(1)}`]: v }) });
const SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  ['!reset', '!override'].flatMap((n) => ['scalar', 'sequence', 'mapping'].map((k) => tag(n, k))),
);
const BASE = yaml.load(read('docker-compose.yml'), { schema: SCHEMA });
const PROD = yaml.load(read('docker-compose.prod.yml'), { schema: SCHEMA });

const env = (file, service) => file.services[service]?.environment ?? {};
const userOf = (url) => /^postgres:\/\/([^:]+):/.exec(url)?.[1];

describe('compose — M9 역할 분리', () => {
  it('base 의 ${X:-changeme…} 기본값마다 prod 에 같은 서비스·키의 ${X:?…} 재정의가 있다(운영에 개발 기본값이 조용히 들어가지 않게)', () => {
    const missing = [];
    let checked = 0;
    for (const [name, svc] of Object.entries(BASE.services)) {
      for (const [key, value] of Object.entries(svc.environment ?? {})) {
        for (const m of String(value).matchAll(/\$\{([A-Z0-9_]+):-changeme[^}]*\}/g)) {
          checked += 1;
          const prodValue = String(env(PROD, name)[key] ?? '');
          if (!prodValue.includes(`\${${m[1]}:?`)) missing.push(`${name}.${key} (${m[1]})`);
        }
      }
    }
    expect(checked).toBe(9); // postgres 1 · migrate 4 · app 2 · partition 1 · backup 1 — a new one must be added here on purpose
    expect(missing).toEqual([]);
  });

  it('migrate: 1회성(restart no·healthcheck 끔), cli/dbSetup.js, postgres healthy 뒤, 역할별 URL 4개', () => {
    const m = BASE.services.migrate;
    expect(m.restart).toBe('no');
    expect(m.healthcheck).toEqual({ disable: true });
    expect(m.command).toEqual(['node', 'dist/cli/dbSetup.js']);
    expect(m.depends_on).toEqual({ postgres: { condition: 'service_healthy' } });
    const e = env(BASE, 'migrate');
    expect(userOf(e.BOOTSTRAP_DATABASE_URL)).toBe('wr_user');
    expect(userOf(e.MIGRATION_DATABASE_URL)).toBe('wr_owner');
    expect(userOf(e.DATABASE_URL)).toBe('wr_app');
    expect(userOf(e.AUDIT_DATABASE_URL)).toBe('wr_audit_reader');
    expect(m.build).toEqual(BASE.services.app.build);
  });

  it('prod migrate: 앱과 같은 패키지 이미지, 빌드 금지(!reset), 같은 역할의 URL', () => {
    const m = PROD.services.migrate;
    expect(m.image).toBe(PROD.services.app.image);
    expect(m.build).toHaveProperty('$reset'); // build: !reset null
    const e = env(PROD, 'migrate');
    expect([e.BOOTSTRAP_DATABASE_URL, e.MIGRATION_DATABASE_URL, e.DATABASE_URL, e.AUDIT_DATABASE_URL].map(userOf))
      .toEqual(['wr_user', 'wr_owner', 'wr_app', 'wr_audit_reader']);
  });

  it('app: wr_app 으로 접속하고 마이그레이션을 직접 돌리지 않으며(AUTO_MIGRATE 없음) migrate 완료 뒤에 뜬다', () => {
    expect(userOf(env(BASE, 'app').DATABASE_URL)).toBe('wr_app');
    expect(userOf(env(PROD, 'app').DATABASE_URL)).toBe('wr_app');
    expect(env(BASE, 'app')).not.toHaveProperty('AUTO_MIGRATE');
    expect(env(PROD, 'app')).not.toHaveProperty('AUTO_MIGRATE');
    expect(env(BASE, 'app').NODE_ENV).toBe('production');
    expect(BASE.services.app.depends_on.migrate).toEqual({ condition: 'service_completed_successfully' });
  });

  it('partition: wr_owner 로 접속(OWNER_DB_PASSWORD), migrate 완료 뒤, 기동 때 한 번 실행하고 실패해도 crond 는 뜬다', () => {
    const p = BASE.services.partition;
    expect(env(BASE, 'partition').PGUSER).toBe('wr_owner');
    expect(env(BASE, 'partition').PGPASSWORD).toMatch(/^\$\{OWNER_DB_PASSWORD:-/);
    expect(env(PROD, 'partition').PGPASSWORD).toMatch(/^\$\{OWNER_DB_PASSWORD:\?/);
    expect(p.depends_on.migrate).toEqual({ condition: 'service_completed_successfully' });
    expect(p.command).toMatch(/sh \/scripts\/audit-partition\.sh \|\| echo [^;]*;\s*crontab \/scripts\/partition-crontab &&\s*crond -f/);
  });

  it('backup: 그대로 부트스트랩 슈퍼유저(pg_dump 는 모든 객체를 읽어야 한다)', () => {
    expect(env(BASE, 'backup').PGUSER).toBe('wr_user');
    expect(env(PROD, 'backup').PGPASSWORD).toMatch(/^\$\{POSTGRES_PASSWORD:\?/);
  });

  it('체크섬 모드는 app 과 migrate 에 같은 고정값(변수로 열지 않음)', () => {
    expect(env(BASE, 'app').MIGRATION_CHECKSUM_MODE).toBe(env(BASE, 'migrate').MIGRATION_CHECKSUM_MODE);
    expect(String(env(BASE, 'migrate').MIGRATION_CHECKSUM_MODE)).not.toContain('$');
  });
  // `!override` 금지는 appLoopbackPublish.test.mjs 가 이미 검사한다.
});
