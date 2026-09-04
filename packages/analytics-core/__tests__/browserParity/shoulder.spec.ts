// §9: Browser/Node parity — shoulder. knee.spec.ts와 같은 패턴. shoulder는 나이 계산을
// 제외하면 타임존 의존이 없으므로(순수 노출시간 산술), 여기서는 번들(ESM/CJS/브라우저) 간
// bit-for-bit 일치만 확인한다.
import { test, expect } from 'playwright/test';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '../../dist');

const FIXTURE = {
  shared: {
    jobs: [{ id: 'job-1', startDate: '2010-01-01', endDate: '2020-01-01' }],
  },
  module: {
    jobExtras: [
      {
        sharedJobId: 'job-1',
        overheadHours: '2',
        repetitiveMediumHours: '1',
        repetitiveFastHours: '0',
        heavyLoadCount: '5',
        heavyLoadSeconds: '10',
        vibrationHours: '0',
      },
    ],
  },
};

async function loadNodeEsm() {
  return import(path.join(distDir, 'modules', 'shoulder', 'index.js'));
}

function loadNodeCjs() {
  const require = createRequire(import.meta.url);
  const cjsPath = path.join(distDir, 'modules', 'shoulder', 'index.cjs');
  delete require.cache[require.resolve(cjsPath)];
  return require(cjsPath);
}

test('computeShoulderCalc: Node(ESM)·Node(CJS)·브라우저 결과가 모두 일치한다', async ({ page }) => {
  const esm = await loadNodeEsm();
  const cjs = loadNodeCjs();

  const esmResult = esm.computeShoulderCalc(FIXTURE);
  const cjsResult = cjs.computeShoulderCalc(FIXTURE);

  await page.goto('/harness.html');
  const browserResultJson = await page.evaluate(
    (fixture) => window.__parity_computeShoulderCalc(JSON.stringify(fixture)),
    FIXTURE,
  );
  const browserResult = JSON.parse(browserResultJson);

  expect(browserResult).toEqual(esmResult);
  expect(browserResult).toEqual(cjsResult);
  expect(browserResult.anyExceeded).toBe(true); // overhead: 2h*250d*10y=5000h > 3600h 한도
});
