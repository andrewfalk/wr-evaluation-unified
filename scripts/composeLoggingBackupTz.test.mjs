import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// 7.3.2 운영 설정: 모든 서비스의 컨테이너 로그 크기 제한, 자동 백업 시각 = 한국 시간 02:00.
// 운영은 docker-compose.yml + docker-compose.prod.yml(Compose v2.22.0) — prod 가 logging 이나 backup 의 TZ 를 덮지 않아야 한다.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const tag = (name, kind) => new yaml.Type(name, { kind, construct: (v) => ({ [`$${name.slice(1)}`]: v }) });
const SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  ['!reset', '!override'].flatMap((n) => ['scalar', 'sequence', 'mapping'].map((k) => tag(n, k))),
);
const BASE = yaml.load(read('docker-compose.yml'), { schema: SCHEMA });
const PROD = yaml.load(read('docker-compose.prod.yml'), { schema: SCHEMA });

describe('compose — 로그 크기 제한·백업 시각', () => {
  it('base 의 모든 서비스가 json-file 로그를 크기·개수 제한으로 쓴다', () => {
    const services = Object.entries(BASE.services);
    expect(services.length).toBeGreaterThan(0);
    for (const [name, svc] of services) {
      expect(svc.logging, name).toEqual({ driver: 'json-file', options: { 'max-size': '50m', 'max-file': '5' } });
    }
  });

  it('prod 오버레이는 logging 을 덮지 않는다', () => {
    for (const [name, svc] of Object.entries(PROD.services)) expect(svc.logging, name).toBeUndefined();
  });

  it('backup 은 TZ=KST-9(POSIX — 이미지에 시간대 자료가 없다)로 크론 02:00 이 한국 시간 02:00 이 되고, prod 가 덮지 않는다', () => {
    expect(BASE.services.backup.environment.TZ).toBe('KST-9');
    expect(PROD.services.backup?.environment?.TZ).toBeUndefined();
    const crontab = read('scripts/backup-crontab').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));
    expect(crontab).toEqual(['0 2 * * * sh /scripts/backup.sh']);
  });

  it('다른 서비스의 시계는 그대로(UTC) — TZ 는 backup 에만', () => {
    for (const [name, svc] of Object.entries(BASE.services)) {
      if (name === 'backup') continue;
      const env = svc.environment ?? {};
      expect(Array.isArray(env) ? env.some((e) => String(e).startsWith('TZ=')) : 'TZ' in env, name).toBe(false);
    }
  });
});
