// 6차 리뷰 권장 사항: vitest의 '@analytics-core' alias(vitest.config.js)는 소스를
// 직접 가리키므로, 여태까지의 유닛 테스트는 registerAnalyticsModule()의 등록 side effect가
// 실제 배포 산출물(빌드된 dist)에서도 일어나는지는 검증하지 못했다. 이 테스트는 dist/index.js
// (ESM)와 dist/index.cjs(CJS)를 상대경로로 직접 import/require해 확인한다.
//
// 루트 package.json의 "pretest" 훅이 npm test 실행 전에 dist를 빌드한다 — dist가 없으면
// 이 테스트는 "빌드를 먼저 하라"는 명확한 에러로 실패해야 한다(조용히 skip하지 않는다).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../dist');

describe('dist smoke — 빌드된 산출물에서 registry가 실제로 등록되는지', () => {
  it('dist/index.js (ESM)를 직접 import하면 knee.relatedness.max가 등록돼 있다', async () => {
    expect(
      existsSync(path.join(distDir, 'index.js')),
      `${distDir}/index.js가 없습니다 — "npm --prefix packages/analytics-core run build"(또는 node scripts/prebuild-analytics-core.mjs)를 먼저 실행하세요`,
    ).toBe(true);
    const mod = await import(path.join(distDir, 'index.js'));
    expect(mod.getRegisteredVariableKeys()).toContain('knee.relatedness.max');
    expect(typeof mod.extractKneeRelatednessMax).toBe('function');
    expect(typeof mod.deterministicMigrate).toBe('function');
  });

  it('dist/index.cjs (CJS)를 require해도 동일하게 동작한다', () => {
    const cjsPath = path.join(distDir, 'index.cjs');
    expect(existsSync(cjsPath), `${cjsPath}가 없습니다 — dist 빌드를 먼저 실행하세요`).toBe(true);
    const require = createRequire(import.meta.url);
    delete require.cache[require.resolve(cjsPath)];
    const mod = require(cjsPath);
    expect(mod.getRegisteredVariableKeys()).toContain('knee.relatedness.max');
    expect(typeof mod.extractKneeRelatednessMax).toBe('function');
  });

  it('ESM과 CJS 산출물의 계산 결과가 일치한다(같은 fixture)', async () => {
    const esm = await import(path.join(distDir, 'index.js'));
    const require = createRequire(import.meta.url);
    const cjs = require(path.join(distDir, 'index.cjs'));

    const fixture = {
      data: {
        shared: { birthDate: '1980-01-01', injuryDate: '2020-01-01', jobs: [] },
        modules: {
          knee: {
            jobExtras: [{ sharedJobId: 'a', weight: '3000', squatting: '120' }],
          },
        },
        activeModules: ['knee'],
      },
    };
    const opts = { caseId: 'case-1', createdAtFallbackIso: '2024-01-01T00:00:00.000Z' };
    // 두 산출물 각각 자신의 jobs 배열을 갖도록 fixture를 복제해서 넣는다(shared.jobs가
    // 마이그레이션 중 채워지므로 같은 객체를 재사용하면 안 된다).
    const esmResult = esm.extractKneeRelatednessMax(
      esm.deterministicMigrate(JSON.parse(JSON.stringify(fixture)), opts),
    );
    const cjsResult = cjs.extractKneeRelatednessMax(
      cjs.deterministicMigrate(JSON.parse(JSON.stringify(fixture)), opts),
    );
    expect(esmResult).toEqual(cjsResult);
  });
});
