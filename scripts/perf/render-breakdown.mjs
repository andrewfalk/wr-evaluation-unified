#!/usr/bin/env node
// 입력 1글자 commit의 컴포넌트별 분해(REFACTORING_ROADMAP Phase 2 P2-42, 트랙 P P-3) — render-timing.mjs와 같은 시나리오(자동저장
// 복원 → 마지막 환자로 전환 → 이름 칸 끝에 1글자)에서, 입력 구간의 commit마다 fiber 트리를 훑어 "이번 commit에서 렌더한" fiber의
// 자기 시간(actualDuration − 렌더한 자식들의 actualDuration)을 컴포넌트 이름별로 합친다. 이름이 남는 프로파일링 빌드가 필요하다:
//
//   npx vite build --config scripts/perf/vite.profiling-names.config.mjs
//   node scripts/perf/render-breakdown.mjs [--count 500] [--runs 3] [--top 15] [--window 500]
//
// --window <ms>: 입력 구간을 "입력 ~ 사이드바 반영"이 아니라 "입력 ~ 입력 + N ms"로 고정한다 — render-timing.mjs의 구간은 화면 반영
// 시각에서 끊겨, 렌더가 빨라지면 입력 직후의 후속 commit이 구간 안으로 들어와 commit 수가 늘어 보일 수 있다(P2-42).
//
// 측정 전용(배포하지 않음). 값은 같은 PC의 상대 비교용이다.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { markdownTable, median, parseArgs, round, startStaticServer } from './lib/perfLib.mjs';
import { generatePatients } from '../../src/core/fixtures/generatePatients.js';

const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const TIMEOUT_MS = 60_000;
const BUILD_DIR = 'dist/perf-profiling-names';

function initScript({ key, payload }) {
  if (!sessionStorage.getItem('__perfSeeded')) {
    localStorage.clear();
    localStorage.setItem(key, payload);
    sessionStorage.setItem('__perfSeeded', '1');
  }
  window.__perf = { inputAt: null, commits: [] };
  window.confirm = () => true;
  document.addEventListener('input', () => { window.__perf.inputAt = performance.now(); }, true);
  const PERFORMED_WORK = 1;
  const nameOf = (fiber) => {
    const t = fiber.type;
    if (!t) return null;
    if (typeof t === 'string') return null; // DOM 요소는 부모 컴포넌트 몫으로
    return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && (t.type.displayName || t.type.name)) || null;
  };
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
      const at = performance.now();
      if (window.__perf.inputAt === null) return; // 입력 전 commit은 분해하지 않는다(비용)
      const self = new Map();
      const stack = [root.current];
      while (stack.length) {
        const fiber = stack.pop();
        if (fiber.flags & PERFORMED_WORK) {
          let childTime = 0;
          for (let c = fiber.child; c; c = c.sibling) if (c.flags & PERFORMED_WORK) childTime += c.actualDuration || 0;
          const name = nameOf(fiber);
          if (name) {
            const cur = self.get(name) || { time: 0, count: 0 };
            cur.time += Math.max(0, (fiber.actualDuration || 0) - childTime);
            cur.count += 1;
            self.set(name, cur);
          }
        }
        for (let c = fiber.child; c; c = c.sibling) stack.push(c);
      }
      window.__perf.commits.push({ at, duration: root.current.actualDuration, self: [...self.entries()] });
    },
  };
}

async function measureOnce(browser, baseUrl, patients, windowMs) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addInitScript(initScript, { key: AUTO_SAVE_KEY, payload: JSON.stringify({ savedAt: '2026-11-07T00:00:00.000Z', patients }) });
  const page = await ctx.newPage();
  const n = patients.length;
  try {
    await page.goto(baseUrl, { waitUntil: 'commit' });
    await page.waitForFunction(count => document.querySelectorAll('.patient-list .patient-item').length === count, n, { polling: 'raf', timeout: TIMEOUT_MS });
    const last = patients[n - 1].data.shared.patientNo;
    await page.locator('.patient-list .patient-item').nth(n - 1).click();
    await page.waitForFunction(no => [...document.querySelectorAll('input')].some(i => i.value === no), last, { polling: 'raf', timeout: TIMEOUT_MS });
    const lastName = patients[n - 1].data.shared.name;
    await page.evaluate((name) => {
      const el = [...document.querySelectorAll('input')].find(i => i.value === name);
      el.setAttribute('data-perf-type-target', '1');
    }, lastName);
    await page.locator('[data-perf-type-target]').focus();
    await page.keyboard.press('End');
    await page.keyboard.type('x');
    const typedAt = await page.waitForFunction(
      expected => [...document.querySelectorAll('.patient-list .patient-item-title')].some(t => t.textContent === expected) ? performance.now() : null,
      `${lastName}x`, { polling: 'raf', timeout: TIMEOUT_MS },
    ).then(h => h.jsonValue());
    if (windowMs) await page.waitForTimeout(windowMs + 50);
    const { inputAt, commits } = await page.evaluate(() => window.__perf);
    const until = windowMs ? inputAt + windowMs : typedAt + 1;
    const inRange = commits.filter(c => c.at >= inputAt && c.at <= until);
    const total = new Map();
    for (const c of inRange) for (const [name, v] of c.self) {
      const cur = total.get(name) || { time: 0, count: 0 };
      cur.time += v.time; cur.count += v.count;
      total.set(name, cur);
    }
    return { commits: inRange.length, commitTotal: inRange.reduce((s, c) => s + c.duration, 0), byComponent: total };
  } finally {
    await ctx.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Number(args.count ?? 500);
  const runs = Number(args.runs ?? 3);
  const top = Number(args.top ?? 15);
  const windowMs = args.window ? Number(args.window) : 0;
  if (!fs.existsSync(path.join(BUILD_DIR, 'index.html'))) {
    console.error(`render-breakdown: ${BUILD_DIR} 이 없습니다 — npx vite build --config scripts/perf/vite.profiling-names.config.mjs`);
    process.exit(1);
  }
  const base = JSON.parse(fs.readFileSync(path.resolve('src/core/fixtures/goldenPatients.json'), 'utf8'));
  const patients = generatePatients(count, base);
  const browser = await chromium.launch();
  const server = await startStaticServer(BUILD_DIR);
  const list = [];
  try {
    for (let i = 0; i < runs; i += 1) list.push(await measureOnce(browser, server.url, patients, windowMs));
  } finally {
    await server.close();
    await browser.close();
  }
  const names = new Set(list.flatMap(r => [...r.byComponent.keys()]));
  const rows = [...names].map(name => {
    const times = list.map(r => r.byComponent.get(name)?.time ?? 0);
    const counts = list.map(r => r.byComponent.get(name)?.count ?? 0);
    return { name, time: median(times), count: median(counts) };
  }).sort((a, b) => b.time - a.time).slice(0, top);
  const span = windowMs ? `입력 후 ${windowMs} ms` : '입력 ~ 사이드바 반영';
  console.log(`입력 1글자(${count}명, ${runs}회 중앙값, ${span}): commit ${median(list.map(r => r.commits))}회 [${list.map(r => r.commits).join(', ')}] / 합 ${round(median(list.map(r => r.commitTotal)))} ms`);
  console.log(markdownTable(['컴포넌트', '자기 시간 ms', '렌더 수'], rows.map(r => [r.name, round(r.time), r.count])));
}

await main();
