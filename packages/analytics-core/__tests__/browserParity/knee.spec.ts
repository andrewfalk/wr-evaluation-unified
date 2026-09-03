// §9: Browser/Node parity. Node(ESM+CJS)와 실제 Chromium에서 같은 fixture로 계산·마이그레이션
// 결과가 일치하는지 확인한다. jsdom은 실제 브라우저 엔진이 아니므로(계획서 §4.4) 이 스펙이
// 필요하다.
import { test, expect } from 'playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');

const MIGRATE_OPTS = { caseId: 'case-1', createdAtFallbackIso: '2024-01-01T00:00:00.000Z' };

// §9.2: 정확히 30세가 되는 fixture(1990-03-01→2020-03-01)는 두 극단 타임존 모두 30세를
// 내 버그를 못 잡는다(직접 계산해 확인 완료) — 대신 age=31(경계 초과)이 한쪽 타임존에서
// 30으로 밀릴 수 있었던 값을 쓴다. §4.6 수정 전 로직(new Date(문자열) UTC 파싱 + 로컬
// getter)이라면 UTC/한국 등에서는 31세, America/Los_Angeles(UTC-8)에서는 1992-02-29→
// 2023-02-28로 밀려 30세가 됐을 것 — missing 자체가 달라지므로(계산됨 vs not_applicable)
// 검출이 명확하다.
const AGE_BOUNDARY_FIXTURE = {
  data: {
    shared: {
      birthDate: '1992-03-01',
      injuryDate: '2023-03-01',
      jobs: [{ id: 'job-1', startDate: '2000-01-01', endDate: '2010-01-01', workPeriodOverride: '' }],
    },
    modules: {
      knee: { jobExtras: [{ sharedJobId: 'job-1', weight: '3000', squatting: '120' }] },
    },
    activeModules: ['knee'],
  },
};

async function loadNodeEsm() {
  return import(path.join(distDir, 'modules', 'knee', 'index.js'));
}

function loadNodeCjs() {
  const require = createRequire(import.meta.url);
  const cjsPath = path.join(distDir, 'modules', 'knee', 'index.cjs');
  delete require.cache[require.resolve(cjsPath)];
  return require(cjsPath);
}

async function loadNodeMigration() {
  return import(path.join(distDir, 'migration', 'deterministicMigrate.js'));
}

test.use({ timezoneId: 'America/Los_Angeles' });

test('sanity: Node·브라우저가 서로 다른 극단 타임존을 실제로 쓰고 있다', async ({ page }) => {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Pacific/Kiritimati');
  await page.goto('/harness.html');
  const browserTz = await page.evaluate(() => window.__parity_timezone());
  expect(browserTz).toBe('America/Los_Angeles');
});

test('computeKneeCalc: 나이 경계 fixture가 Node(ESM)·Node(CJS)·브라우저에서 모두 일치한다', async ({ page }) => {
  const esm = await loadNodeEsm();
  const cjs = loadNodeCjs();
  const migration = await loadNodeMigration();

  const migrated = migration.deterministicMigrate(
    JSON.parse(JSON.stringify(AGE_BOUNDARY_FIXTURE)),
    MIGRATE_OPTS,
  );

  const esmResult = esm.computeKneeCalc({ shared: migrated.payload.data.shared, module: migrated.payload.data.modules.knee });
  const cjsResult = cjs.computeKneeCalc({ shared: migrated.payload.data.shared, module: migrated.payload.data.modules.knee });

  // 정상 경로라면 age===31(30세 초과)이라 relatedness가 실제로 계산된다 — §4.6 수정 전
  // 버그였다면 브라우저(LA) 쪽에서 age===30으로 밀려 다른 계산 분기를 탔을 것이다.
  expect(esmResult.age).toBe(31);
  expect(cjsResult.age).toBe(31);

  await page.goto('/harness.html');
  const browserResultJson = await page.evaluate(
    ({ shared, module }) => window.__parity_computeKneeCalc(JSON.stringify({ shared, module })),
    { shared: migrated.payload.data.shared, module: migrated.payload.data.modules.knee },
  );
  const browserResult = JSON.parse(browserResultJson);

  expect(browserResult.age).toBe(31);
  expect(browserResult).toEqual(esmResult);
  expect(browserResult).toEqual(cjsResult);
});

test('deterministicMigrate: 결과가 Node와 브라우저에서 일치한다', async ({ page }) => {
  const migration = await loadNodeMigration();
  const nodeResult = migration.deterministicMigrate(
    JSON.parse(JSON.stringify(AGE_BOUNDARY_FIXTURE)),
    MIGRATE_OPTS,
  );

  await page.goto('/harness.html');
  const browserResultJson = await page.evaluate(
    ({ fixture, opts }) => window.__parity_migrate(JSON.stringify(fixture), JSON.stringify(opts)),
    { fixture: AGE_BOUNDARY_FIXTURE, opts: MIGRATE_OPTS },
  );
  const browserResult = JSON.parse(browserResultJson);

  expect(browserResult).toEqual(nodeResult);
});

// §4.2 job 3분류 — Node/Chromium parity(계획서 §9.2 "job 분류 9종 fixture도 같은 spec에서
// Node/브라우저 비교"에 대응. vitest(extractors.test.ts)는 소스를 직접 검사하지만, 여기서는
// 빌드된 dist를 실제 Chromium에서 돌려 번들 결과까지 일치하는지 확인한다).
const JOB_CLASSIFICATION_FIXTURES: Array<{ label: string; job: Record<string, unknown> }> = [
  { label: 'complete job', job: { startDate: '2000-01-01', endDate: '2010-01-01', weight: '3000', squatting: '120' } },
  { label: 'startDate만 입력', job: { startDate: '2000-01-01' } },
  { label: '모든 필드 blank(empty)', job: {} },
  { label: 'endDate < startDate', job: { startDate: '2010-01-01', endDate: '2000-01-01', weight: '100', squatting: '50' } },
  { label: 'workPeriodOverride 비정형("abc")', job: { workPeriodOverride: 'abc', weight: '100', squatting: '50' } },
  { label: 'startDate === endDate', job: { startDate: '2010-01-01', endDate: '2010-01-01', weight: '100', squatting: '50' } },
  { label: 'weight/squatting이 null/undefined', job: { startDate: '2000-01-01', endDate: '2010-01-01', weight: null, squatting: undefined } },
  { label: '기간 필드 없이 weight/squatting만', job: { weight: '100', squatting: '50' } },
  { label: '음수 weight("-10")', job: { startDate: '2000-01-01', endDate: '2010-01-01', weight: '-10', squatting: '50' } },
  { label: '단위 접미 문자열("12kg")', job: { startDate: '2000-01-01', endDate: '2010-01-01', weight: '12kg', squatting: '50' } },
  { label: 'workPeriodOverride만으로 complete', job: { workPeriodOverride: '5년', weight: '100', squatting: '50' } },
];

test('classifyKneeJob: §4.2 job 분류 10종 fixture 전체가 Node·브라우저에서 동일하게 분류된다', async ({ page }) => {
  const esm = await loadNodeEsm();
  await page.goto('/harness.html');

  for (const { label, job } of JOB_CLASSIFICATION_FIXTURES) {
    const nodeResult = esm.classifyKneeJob(job);
    const browserResultJson = await page.evaluate(
      (jobJson) => window.__parity_classifyKneeJob(jobJson),
      JSON.stringify(job),
    );
    const browserResult = JSON.parse(browserResultJson);
    expect(browserResult, `fixture "${label}": browser=${browserResult} node=${nodeResult}`).toBe(nodeResult);
  }
});

test('uuidv5 기반 결정적 job id가 Node·브라우저에서 동일하다(구형식 job 백필 케이스)', async ({ page }) => {
  const migration = await loadNodeMigration();
  const legacyFixture = {
    data: {
      shared: {},
      modules: { knee: { jobs: [{ weight: '100', squatting: '50' }] } },
      activeModules: ['knee'],
    },
  };
  const nodeResult = migration.deterministicMigrate(JSON.parse(JSON.stringify(legacyFixture)), MIGRATE_OPTS);

  await page.goto('/harness.html');
  const browserResultJson = await page.evaluate(
    ({ fixture, opts }) => window.__parity_migrate(JSON.stringify(fixture), JSON.stringify(opts)),
    { fixture: legacyFixture, opts: MIGRATE_OPTS },
  );
  const browserResult = JSON.parse(browserResultJson);

  expect(browserResult.payload.data.shared.jobs[0].id).toBe(nodeResult.payload.data.shared.jobs[0].id);
});
