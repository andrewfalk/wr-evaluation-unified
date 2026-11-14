// P0-13 성능 기준선 ④ — 화면 렌더링(환자 100·500명).
//
// 로컬 모드 웹 빌드를 측정 전용 정적 서버(127.0.0.1)로 열고, 결정적 N명(src/core/fixtures/generatePatients.js
// — 골든 환자 복제)을 자동저장 키(wrEvalUnifiedAutoSave)에 넣은 뒤 앱의 "이어서 작업" 확인을 수락해 복원한다.
// 잰 값(브라우저 performance.now 기준, ms):
//   - boot:          탐색 시작 → 앱이 자동저장 복원 확인을 묻는 순간(앱 기동·설정 로드)
//   - restoreRender: 확인 수락 → 환자 목록에 N개 카드가 모두 그려짐
//   - switchPatient: 마지막 환자 카드 클릭 → 기본정보 폼의 환자등록번호가 그 환자 값이 됨
//   - typeChar:      그 환자의 이름 칸 끝에 1글자 입력(input 이벤트) → 사이드바 카드 이름이 바뀜(P-3 기준선,
//                    REFACTORING_ROADMAP Phase 2 P2-31b — C4 환자 상태 컨테이너 전후·P2-42 셀렉터 전후 비교용)
//   - dashboard:     '대시보드' 클릭 → 대시보드 표(최근 목록)가 그려짐
// --profiling 빌드(scripts/perf/vite.profiling.config.mjs)로 돌리면 각 구간의 React commit 횟수·
// actualDuration 합계·최대도 함께 모은다(가짜 DevTools 훅, 앱 코드 수정 없음).
// 각 (N, 빌드) 조합을 --runs번(기본 3) 새 브라우저 컨텍스트에서 반복해 중앙값을 낸다.
//
//   npm run build:web
//   npx vite build --config scripts/perf/vite.profiling.config.mjs
//   node scripts/perf/render-timing.mjs [--counts 100,500] [--runs 3] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { describeEnvironment, markdownTable, median, parseArgs, round, startStaticServer } from './lib/perfLib.mjs';
import { generatePatients } from '../../src/core/fixtures/generatePatients.js';

const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const TIMEOUT_MS = 60_000;

// 페이지에 먼저 심는 계측: confirm() 자동 수락 + 시각 기록, 클릭 시각, (프로파일링 빌드면) commit 기록.
function initScript({ key, payload }) {
  if (!sessionStorage.getItem('__perfSeeded')) {
    localStorage.clear();
    localStorage.setItem(key, payload);
    sessionStorage.setItem('__perfSeeded', '1');
  }
  window.__perf = { confirmAt: null, clickAt: null, inputAt: null, commits: [] };
  window.confirm = () => { window.__perf.confirmAt = performance.now(); return true; };
  document.addEventListener('click', () => { window.__perf.clickAt = performance.now(); }, true);
  document.addEventListener('input', () => { window.__perf.inputAt = performance.now(); }, true);
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true,
    isDisabled: false,
    renderers: new Map(),
    inject() { return 1; },
    checkDCE() {},
    onScheduleFiberRoot() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id, root) {
      const d = root?.current?.actualDuration;
      if (typeof d === 'number') window.__perf.commits.push({ at: performance.now(), duration: d });
    },
  };
}

function commitStats(commits, from, to) {
  const inRange = commits.filter(c => c.at >= from && c.at <= to + 1);
  if (inRange.length === 0) return null;
  return {
    count: inRange.length,
    total: inRange.reduce((s, c) => s + c.duration, 0),
    max: Math.max(...inRange.map(c => c.duration)),
  };
}

async function measureOnce(browser, baseUrl, patients) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const payload = JSON.stringify({ savedAt: '2026-11-07T00:00:00.000Z', patients });
  await ctx.addInitScript(initScript, { key: AUTO_SAVE_KEY, payload });
  const page = await ctx.newPage();
  const n = patients.length;
  try {
    await page.goto(baseUrl, { waitUntil: 'commit' });
    const restoredAt = await page.waitForFunction(
      count => document.querySelectorAll('.patient-list .patient-item').length === count ? performance.now() : null,
      n, { polling: 'raf', timeout: TIMEOUT_MS },
    ).then(h => h.jsonValue());
    const confirmAt = await page.evaluate(() => window.__perf.confirmAt);
    if (confirmAt === null) throw new Error('자동저장 복원 확인(confirm)이 호출되지 않았습니다');

    const last = patients[n - 1].data.shared.patientNo;
    await page.locator('.patient-list .patient-item').nth(n - 1).click();
    const switchedAt = await page.waitForFunction(
      no => [...document.querySelectorAll('input')].some(i => i.value === no) ? performance.now() : null,
      last, { polling: 'raf', timeout: TIMEOUT_MS },
    ).then(h => h.jsonValue());
    const switchClick = await page.evaluate(() => window.__perf.clickAt);

    // 입력 1글자: 기본정보 폼에서 값이 그 환자 이름인 입력칸 끝에 'x'를 친다. 이름은 골든 복제라 겹칠 수 있지만
    // 'x'가 붙은 이름은 이 환자 하나뿐이다.
    const lastName = patients[n - 1].data.shared.name;
    const marked = await page.evaluate((name) => {
      const el = [...document.querySelectorAll('input')].find(i => i.value === name);
      if (!el) return false;
      el.setAttribute('data-perf-type-target', '1');
      return true;
    }, lastName);
    if (!marked) throw new Error(`이름 입력칸(값 ${lastName})을 찾지 못했습니다`);
    const typeTarget = page.locator('[data-perf-type-target]');
    await typeTarget.focus();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    const typedAt = await page.waitForFunction(
      expected => [...document.querySelectorAll('.patient-list .patient-item-title')].some(t => t.textContent === expected) ? performance.now() : null,
      `${lastName}x`, { polling: 'raf', timeout: TIMEOUT_MS },
    ).then(h => h.jsonValue());
    const inputAt = await page.evaluate(() => window.__perf.inputAt);

    await page.getByRole('button', { name: '대시보드', exact: true }).first().click();
    const dashAt = await page.waitForFunction(
      () => document.querySelector('.dashboard .dashboard-table') ? performance.now() : null,
      null, { polling: 'raf', timeout: TIMEOUT_MS },
    ).then(h => h.jsonValue());
    const dashClick = await page.evaluate(() => window.__perf.clickAt);
    const commits = await page.evaluate(() => window.__perf.commits);

    return {
      boot: confirmAt,
      restoreRender: restoredAt - confirmAt,
      switchPatient: switchedAt - switchClick,
      typeChar: typedAt - inputAt,
      dashboard: dashAt - dashClick,
      commits: {
        restoreRender: commitStats(commits, confirmAt, restoredAt),
        switchPatient: commitStats(commits, switchClick, switchedAt),
        typeChar: commitStats(commits, inputAt, typedAt),
        dashboard: commitStats(commits, dashClick, dashAt),
      },
    };
  } finally {
    await ctx.close();
  }
}

const PHASES = ['boot', 'restoreRender', 'switchPatient', 'typeChar', 'dashboard'];
const COMMIT_PHASES = ['restoreRender', 'switchPatient', 'typeChar', 'dashboard'];

function summarizeRuns(runs) {
  const out = {};
  for (const phase of PHASES) out[phase] = round(median(runs.map(r => r[phase])));
  out.commits = {};
  for (const phase of COMMIT_PHASES) {
    const list = runs.map(r => r.commits[phase]).filter(Boolean);
    out.commits[phase] = list.length === 0 ? null : {
      count: median(list.map(c => c.count)),
      total: round(median(list.map(c => c.total))),
      max: round(median(list.map(c => c.max))),
    };
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const counts = String(args.counts ?? '100,500').split(',').map(Number);
  const runs = Number(args.runs ?? 3);
  const builds = [
    { name: '운영 빌드', dir: 'dist/web' },
    { name: '프로파일링 빌드', dir: 'dist/perf-profiling' },
  ].filter(b => fs.existsSync(path.join(b.dir, 'index.html')));
  if (builds.length === 0) {
    console.error('render-timing: dist/web 이 없습니다 — npm run build:web');
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(path.resolve('src/core/fixtures/goldenPatients.json'), 'utf8'));
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const build of builds) {
      const server = await startStaticServer(build.dir);
      try {
        for (const n of counts) {
          const patients = generatePatients(n, base);
          const list = [];
          for (let i = 0; i < runs; i += 1) list.push(await measureOnce(browser, server.url, patients));
          results.push({ build: build.name, n, runs: list, median: summarizeRuns(list) });
          console.error(`  ${build.name} N=${n}: ${runs}회 완료`);
        }
      } finally {
        await server.close();
      }
    }
  } finally {
    await browser.close();
  }

  console.log(markdownTable(
    ['빌드', '환자 수', '기동 ms', '복원 렌더 ms', '환자 전환 ms', '입력 1글자 ms', '대시보드 ms'],
    results.map(r => [r.build, r.n, r.median.boot, r.median.restoreRender, r.median.switchPatient, r.median.typeChar, r.median.dashboard]),
  ));
  const profiled = results.filter(r => r.median.commits.restoreRender);
  if (profiled.length > 0) {
    const cell = c => (c ? `${c.count}회 / 합 ${c.total} / 최대 ${c.max}` : null);
    console.log('');
    console.log(markdownTable(
      ['빌드', '환자 수', '복원 commit', '환자 전환 commit', '입력 1글자 commit', '대시보드 commit'],
      profiled.map(r => [r.build, r.n, cell(r.median.commits.restoreRender), cell(r.median.commits.switchPatient), cell(r.median.commits.typeChar), cell(r.median.commits.dashboard)]),
    ));
  }
  if (typeof args.json === 'string') {
    fs.writeFileSync(args.json, `${JSON.stringify({ environment: await describeEnvironment(), runsPerCase: runs, results }, null, 2)}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
