#!/usr/bin/env node
// 환자 동기화 실서버 확인(REFACTORING_ROADMAP Phase 2 게이트 B P2-41b) — 떠 있는 스택(dev 또는 패키지)에 대해 Playwright(헤드리스
// Chromium) 창 여러 개로 저장·충돌·락·전환·삭제·범위·오프라인·담당 변경·일괄 가져오기·재로그인을 실제 서버로 지난다.
// P2-41c(usePatientSync가 스토어를 직접 읽음)·P2-41d(엔진 이동) 뒤에 돌린다. `npm run check`에는 넣지 않는다(스택·DB 필요).
//
// 시험 조직 1개와 의사 계정 2개(A·B)를 실행마다 무작위 이름·비밀번호로 DB에 만들고, 끝나면(실패해도) finally에서 지운다
// (조직·계정·환자·세션·락·멱등 키 — 조직 단위 삭제). 저장소에는 계정 값·호스트를 두지 않는다 — 대상은 환경 변수로 받는다:
//   WR_WEB_URL        웹 화면 주소(예: dev는 Vite 개발 서버)                — 필수
//   WR_PG_CONTAINER   PostgreSQL 컨테이너 이름(docker exec로 psql 실행)      — 필수
//   WR_PG_USER, WR_PG_DB  DB 사용자·DB 이름(없으면 개발 기본값)
//   WR_API_BASE       화면 설정의 서버 주소(없으면 '' = 같은 origin)
//   WR_IGNORE_HTTPS_ERRORS=1  자체 서명 인증서(패키지 스택 리허설)
//
// ⑬은 D3(push 못 하는 dirty 환자의 1초 pull 반복, 2026-11-16 수정)를 실서버에서 확인한다.
//
// 사용: WR_WEB_URL=… WR_PG_CONTAINER=… node scripts/tier3/patient-sync-smoke.mjs
//       WR_PG_CONTAINER=… node scripts/tier3/patient-sync-smoke.mjs --cleanup-stale   (이전 실행이 남긴 시험 조직만 지움)
// "기록" 항목(⑧ D1 경로·⑪ D2 PATCH 수)은 통과·실패가 아니라 관찰값을 남긴다(결함 후보의 실서버 확인용).
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const requireFromServer = createRequire(path.join(ROOT, 'server', 'package.json'));
const bcrypt = requireFromServer('bcrypt');
const { chromium } = await import('playwright');

const WEB_URL = process.env.WR_WEB_URL;
const PG_CONTAINER = process.env.WR_PG_CONTAINER;
const PG_USER = process.env.WR_PG_USER || 'wr_user';
const PG_DB = process.env.WR_PG_DB || 'wr_evaluation';
const API_BASE = process.env.WR_API_BASE || '';
const IGNORE_HTTPS = process.env.WR_IGNORE_HTTPS_ERRORS === '1';
if (!PG_CONTAINER || (!WEB_URL && !process.argv.includes('--cleanup-stale'))) {
  console.error('WR_WEB_URL과 WR_PG_CONTAINER가 필요합니다(스크립트 머리말 참고).');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// DB(docker exec psql) — 값은 이 스크립트가 만든 무작위 hex·bcrypt 해시·환자 id뿐이라 따옴표 안에 그대로 넣는다.
// ---------------------------------------------------------------------------
function sql(statement) {
  const out = execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: statement, encoding: 'utf8',
  });
  return out.trim();
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rand = (n = 6) => randomBytes(n).toString('hex');

const RUN = rand(4);
const ORG_NAME = `tier3-patient-sync-${RUN}`;
const accounts = {
  a: { loginId: `t3sa-${RUN}`, name: `동기화의사A-${RUN}`, password: `Pw-${rand(8)}!a` },
  b: { loginId: `t3sb-${RUN}`, name: `동기화의사B-${RUN}`, password: `Pw-${rand(8)}!b` },
};
let orgId = null;

function createFixtures() {
  orgId = sql(`INSERT INTO organizations (name) VALUES (${q(ORG_NAME)}) RETURNING id;`).split('\n')[0];
  for (const acct of Object.values(accounts)) {
    const hash = bcrypt.hashSync(acct.password, 10);
    acct.id = sql(`INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
      VALUES (${q(acct.loginId)}, ${q(hash)}, ${q(acct.name)}, 'doctor', ${q(orgId)}, false) RETURNING id;`).split('\n')[0];
  }
}

// 시험 조직 하나와 그 조직의 모든 행(환자·락·멱등 키·세션 포함)을 참조 순서대로 지운다. 감사 로그는 추가 전용이라 남는다.
function deleteOrg(id) {
  const o = q(id);
  sql(`BEGIN;
    DELETE FROM patient_locks WHERE organization_id = ${o};
    DELETE FROM video_analysis_jobs WHERE organization_id = ${o};
    DELETE FROM video_analysis_clips WHERE organization_id = ${o};
    DELETE FROM patient_records WHERE organization_id = ${o};
    DELETE FROM patient_persons WHERE organization_id = ${o};
    DELETE FROM workspaces WHERE organization_id = ${o};
    DELETE FROM custom_presets WHERE organization_id = ${o};
    DELETE FROM devices WHERE organization_id = ${o};
    DELETE FROM stats_runs WHERE organization_id = ${o};
    DELETE FROM user_capability_grants WHERE organization_id = ${o};
    DELETE FROM user_signup_requests WHERE organization_id = ${o};
    DELETE FROM autosaves WHERE organization_id = ${o} OR user_id IN (SELECT id FROM users WHERE organization_id = ${o});
    DELETE FROM users WHERE organization_id = ${o};
    DELETE FROM organizations WHERE id = ${o};
    COMMIT;`);
}

const STALE_ORG_RE = '^tier3-patient-sync-[0-9a-f]{8}$';
const STALE_USER_RE = '^t3s[ab]-[0-9a-f]{8}$';
function staleOrgIds() {
  return sql(`SELECT o.id FROM organizations o
    WHERE o.name ~ '${STALE_ORG_RE}'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.login_id !~ '${STALE_USER_RE}');`).split('\n').filter(Boolean);
}

if (process.argv.includes('--cleanup-stale')) {
  const stale = staleOrgIds();
  for (const id of stale) deleteOrg(id);
  console.log(`남아 있던 시험 조직 ${stale.length}개를 지웠습니다.`);
  process.exit(0);
}

const patientRow = (patientNo) => {
  const line = sql(`SELECT id, revision, coalesce(name, ''), coalesce(assigned_doctor_user_id::text, '') FROM patient_records
    WHERE organization_id = ${q(orgId)} AND patient_no = ${q(patientNo)} AND deleted_at IS NULL LIMIT 1;`);
  if (!line) return null;
  const [id, revision, name, assigned] = line.split('|');
  return { id, revision: Number(revision), name, assigned };
};

// ---------------------------------------------------------------------------
// 화면 조작
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const tag = ok === null ? 'NOTE' : ok ? 'PASS' : 'FAIL';
  console.log(`${tag}  ${name}${detail ? ` — ${detail}` : ''}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeout = 10000, interval = 200) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await wait(interval);
  }
  return false;
}

async function newContext(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: IGNORE_HTTPS, viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ apiBase }) => {
    if (!localStorage.getItem('wrEvalUnifiedSettings')) {
      localStorage.setItem('wrEvalUnifiedSettings', JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: apiBase }));
    }
  }, { apiBase: API_BASE });
  return context;
}

async function newTab(context, tag) {
  const page = await context.newPage();
  page.__tag = tag;
  page.__dialogs = [];
  page.__calls = [];
  page.__confirm = true;
  page.on('dialog', (d) => { page.__dialogs.push(d.message()); if (d.type() === 'confirm' && !page.__confirm) d.dismiss(); else d.accept(); });
  page.on('response', (res) => {
    const u = new URL(res.url());
    if (u.pathname.startsWith('/api/patients')) {
      page.__calls.push({ method: res.request().method(), path: u.pathname, query: u.search, status: res.status(), t: Date.now(), injected: !!page.__injecting });
    }
  });
  page.on('pageerror', (e) => console.log(`[${tag}] pageerror ${e.message}`));
  await page.goto(WEB_URL);
  return page;
}
const callsSince = (page, i, method) => page.__calls.slice(i).filter((c) => !method || c.method === method);

// 서버는 로그인을 IP당 1분에 5회로 제한한다 — 간격을 지키고, 걸리면 기다렸다가 다시 누른다(account-switch-smoke와 같은 방식).
const LOGIN_LIMIT = 4;
const LOGIN_WINDOW_MS = 62_000;
const loginTimes = [];
async function paceLogin() {
  for (;;) {
    const now = Date.now();
    while (loginTimes.length && now - loginTimes[0] > LOGIN_WINDOW_MS) loginTimes.shift();
    if (loginTimes.length < LOGIN_LIMIT) { loginTimes.push(now); return; }
    await wait(LOGIN_WINDOW_MS - (now - loginTimes[0]) + 200);
  }
}
const onLoginScreen = (page) => page.getByRole('heading', { name: '인트라넷 로그인' }).isVisible().catch(() => false);
const addButton = (page) => page.getByRole('button', { name: /^\+ (추가|새환자)$/ }).first();

async function login(page, acct) {
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 30000 });
  await page.getByLabel('아이디').fill(acct.loginId);
  await page.getByLabel('비밀번호').fill(acct.password);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await paceLogin();
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    const limited = await page.getByText('로그인 시도가 너무 많습니다', { exact: false }).waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
    if (!limited) break;
    await wait(LOGIN_WINDOW_MS);
  }
  await until(async () => !(await onLoginScreen(page)), 20000);
  await addButton(page).waitFor({ timeout: 20000 });
}

async function logout(page, acct) {
  const menu = page.getByRole('button', { name: new RegExp(acct.name) });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  } else {
    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).last().click();
  }
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 15000 });
}

async function addPatient(page, patientNo, name) {
  await addButton(page).click();
  await page.getByRole('heading', { name: '새 환자 평가' }).waitFor();
  await page.getByPlaceholder('등록번호').fill(patientNo);
  await page.locator('.form-group', { hasText: '이름 *' }).locator('input').first().fill(name);
  await page.getByRole('button', { name: /다음: 상병 입력/ }).click();
  await page.getByRole('button', { name: /다음: 모듈 선택/ }).click();
  await page.getByRole('checkbox', { name: /어깨/ }).check();
  await page.getByRole('button', { name: /평가 시작/ }).click();
  await page.getByText(new RegExp(`#${patientNo}`)).first().waitFor();
}

const row = (page, patientNo) => page.locator('.patient-item', { hasText: `#${patientNo}` }).first();
async function openPatient(page, patientNo) {
  await row(page, patientNo).click();
  await until(async () => (await page.getByPlaceholder('등록번호').inputValue().catch(() => '')) === patientNo, 15000);
}
async function setActiveName(page, name) {
  await page.getByText('기본정보', { exact: true }).first().click();
  const input = page.locator('xpath=//label[normalize-space()="이름 *"]/following-sibling::input[1]').first();
  await input.fill(name);
}
const bodyText = (page) => page.evaluate(() => document.body.innerText);
const listText = (page) => page.getByText(/^환자 목록 \(\d+\)$/).first().textContent({ timeout: 3000 }).catch(() => null);
const pendingGone = (page) => until(async () => !(await bodyText(page)).includes('저장 대기'), 10000);
const pullNow = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')));
async function editable(page) {
  return until(async () => !/조회만 가능합니다|편집 권한을 상실/.test(await bodyText(page)), 15000);
}
// 편집 전에 이 창이 락을 갖게 한다 — 같은 계정의 다른 창이 같은 환자를 열어 두면(시나리오 순서에 따라) 그쪽이 락을 다시 잡아
// 이 창은 조회 전용이 된다. 그러면 강제 인수한다. 결과(이미 보유/강제 인수/실패)를 돌려줘 기록에 남긴다.
async function ensureEditable(page) {
  if (await until(async () => !/조회만 가능합니다|편집 권한을 상실/.test(await bodyText(page)), 5000)) return 'held';
  const force = page.getByRole('button', { name: '강제로 편집 권한 가져오기' });
  if (await force.isVisible().catch(() => false)) {
    await force.click();
    if (await editable(page)) return 'forced';
  }
  return 'view-only';
}

async function step(name, fn) {
  try { await fn(); } catch (error) { record(`${name} — 스크립트 오류`, false, String(error?.message || error).split('\n')[0]); }
}

// ---------------------------------------------------------------------------
// 시나리오(계획 "Tier-3 실서버 시나리오" 1~12)
// ---------------------------------------------------------------------------
const P1 = `S1-${RUN}`;
const P2 = `S2-${RUN}`;
const PB = `SB-${RUN}`;

async function run(browser) {
  const ctxA1 = await newContext(browser);
  const a1 = await newTab(ctxA1, 'A1');
  await login(a1, accounts.a);

  await step('① 편집 → 저장 → 새로고침 뒤 유지', async () => {
    await addPatient(a1, P1, `동기화환자1-${RUN}`);
    await addPatient(a1, P2, `동기화환자2-${RUN}`);
    await until(() => patientRow(P1) && patientRow(P2), 15000);
    await pendingGone(a1);
    await openPatient(a1, P1);
    await editable(a1);
    const i = a1.__calls.length;
    await setActiveName(a1, `동기화환자1수정-${RUN}`);
    const patched = await until(() => callsSince(a1, i, 'PATCH').some((c) => c.status < 300), 10000);
    await pendingGone(a1);
    await wait(2500);
    const patchCount = callsSince(a1, i, 'PATCH').length;
    await a1.reload();
    await addButton(a1).waitFor({ timeout: 30000 });
    const kept = await until(async () => (await bodyText(a1)).includes(`동기화환자1수정-${RUN}`), 15000);
    record('① 편집 → 1초 뒤 PATCH 2xx·재전송 없음 → 새로고침 뒤 유지', patched && patchCount === 1 && kept, `PATCH ${patchCount}회, DB 이름 ${patientRow(P1)?.name === `동기화환자1수정-${RUN}`}`);
  });

  await step('② 다른 곳의 저장(서버 revision 증가) → 409 충돌 표시 → 서버 쪽 선택으로 해결', async () => {
    await openPatient(a1, P1);
    await editable(a1);
    const before = patientRow(P1);
    sql(`UPDATE patient_records SET revision = revision + 1 WHERE id = ${q(before.id)};`);
    const i = a1.__calls.length;
    await setActiveName(a1, `동기화환자1충돌-${RUN}`);
    const got409 = await until(() => callsSince(a1, i, 'PATCH').some((c) => c.status === 409), 10000);
    const badge = await until(async () => (await row(a1, P1).innerText()).includes('Resolve'), 10000);
    await row(a1, P1).getByRole('button', { name: 'Resolve' }).click();
    await a1.getByRole('button', { name: 'Use Server' }).click();
    const resolved = await until(async () => !(await row(a1, P1).innerText()).includes('Resolve'), 10000);
    record('② 409 → 충돌 표시 → Use Server로 해결', got409 && badge && resolved, `409=${got409} badge=${badge} resolved=${resolved}`);
  });

  const ctxA2 = await newContext(browser);
  const a2 = await newTab(ctxA2, 'A2');
  await login(a2, accounts.a);

  await step('③ 한 창이 락 보유 중 다른 창이 강제 인수 → 락 상실 배너·편집 차단', async () => {
    await openPatient(a1, P1);
    await editable(a1);
    await openPatient(a2, P1);
    const viewOnly = await until(async () => /조회만 가능합니다/.test(await bodyText(a2)), 15000);
    await a2.getByRole('button', { name: '강제로 편집 권한 가져오기' }).click();
    const a2Edit = await editable(a2);
    const a1Lost = await until(async () => /편집 권한을 상실|조회만 가능합니다/.test(await bodyText(a1)), 90000, 1000);
    record('③ 강제 인수 → A2 편집 가능, A1 락 상실·조회 전용', viewOnly && a2Edit && a1Lost, `viewOnly=${viewOnly} a2=${a2Edit} a1Lost=${a1Lost}`);
  });

  await step('④ 저장 중 환자 전환(flush 대기) → 전환 뒤 이전 환자 synced', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let intercepted = false;
    await a2.route('**/api/patients/*', async (route) => {
      if (route.request().method() === 'PATCH') { intercepted = true; await gate; }
      await route.continue();
    });
    const i = a2.__calls.length;
    a2.__dialogs.length = 0;
    await setActiveName(a2, `동기화환자1전환-${RUN}`);
    await row(a2, P2).click();
    // 저장(PATCH)이 붙잡혀 있는 동안에는 전환되지 않아야 한다(flush 대기, #341 Codex 3회차 권고).
    await until(() => intercepted, 10000);
    await wait(800);
    const heldBeforeRelease = (await a2.getByPlaceholder('등록번호').inputValue().catch(() => '')) === P1;
    release();
    const switched = await until(async () => (await a2.getByPlaceholder('등록번호').inputValue().catch(() => '')) === P2, 15000);
    await a2.unrouteAll({ behavior: 'ignoreErrors' });
    const saved = callsSince(a2, i, 'PATCH').some((c) => c.status < 300);
    const dbName = patientRow(P1)?.name;
    record('④ 저장 후 이동 확인 → 저장이 끝날 때까지 전환 대기 → PATCH 2xx → 전환, 이전 환자 저장됨',
      intercepted && heldBeforeRelease && switched && saved && dbName === `동기화환자1전환-${RUN}`,
      `intercepted=${intercepted} held=${heldBeforeRelease} dialogs=${JSON.stringify(a2.__dialogs)}`);
  });

  await step('⑤ "저장하지 않고 이동" → 다시 열면 저장 재개', async () => {
    await openPatient(a2, P1);
    const lockBefore = await ensureEditable(a2);
    a2.__injecting = true; // 이 구간의 PATCH 503은 스크립트가 만든 것 — 마지막 5xx 검사에서 뺀다
    await a2.route('**/api/patients/*', (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"unavailable"}' })
      : route.continue()));
    a2.__dialogs.length = 0;
    await setActiveName(a2, `동기화환자1보류-${RUN}`);
    await row(a2, P2).click();
    const moved = await until(async () => (await a2.getByPlaceholder('등록번호').inputValue().catch(() => '')) === P2, 20000);
    const askedSkip = a2.__dialogs.some((m) => m.includes('저장하지 않고 이동'));
    await a2.unrouteAll({ behavior: 'ignoreErrors' });
    a2.__injecting = false;
    await wait(2500);
    const stillOld = patientRow(P1)?.name !== `동기화환자1보류-${RUN}`;
    const i = a2.__calls.length;
    await openPatient(a2, P1);
    // 다시 열 때 다른 창(A1 — ③부터 P1을 열어 둠)이 그사이 락을 다시 잡았으면 강제 인수한다(재개는 락을 얻어야 된다).
    const lockAfter = await ensureEditable(a2);
    const resumed = await until(() => callsSince(a2, i, 'PATCH').some((c) => c.status < 300), 15000);
    record('⑤ 저장 실패 → 저장하지 않고 이동 → 일시정지(저장 안 됨) → 다시 열면 저장', moved && askedSkip && stillOld && resumed
      && patientRow(P1)?.name === `동기화환자1보류-${RUN}`, `moved=${moved} asked=${askedSkip} paused=${stillOld} resumed=${resumed} 락 ${lockBefore}→${lockAfter}`);
  });

  await step('⑥ 삭제 → 다른 창 pull에서 사라짐, 활성 환자 폴백', async () => {
    await openPatient(a2, P2);
    const i = a2.__calls.length;
    await row(a2, P2).getByRole('button', { name: '삭제' }).click();
    const deleted = await until(() => callsSince(a2, i, 'DELETE').some((c) => /^\/api\/patients\/[^/]+$/.test(c.path) && c.status < 300), 15000);
    const fallback = await until(async () => (await a2.getByPlaceholder('등록번호').inputValue().catch(() => '')) === P1, 10000);
    await pullNow(a1);
    const goneInA1 = await until(async () => (await row(a1, P2).count()) === 0, 15000);
    record('⑥ DELETE 2xx → 남은 환자 활성 → 다른 창 pull에서 사라짐', deleted && fallback && goneInA1, `deleted=${deleted} fallback=${fallback} goneA1=${goneInA1}`);
  });

  const ctxB = await newContext(browser);
  const b1 = await newTab(ctxB, 'B1');
  await login(b1, accounts.b);
  await addPatient(b1, PB, `B환자-${RUN}`);
  await until(() => patientRow(PB), 15000);

  await step('⑦ 범위 변경 중 pull → 옛 범위 결과가 섞이지 않음', async () => {
    await a1.getByRole('button', { name: '대시보드' }).click();
    const select = a1.locator('.patient-scope-select');
    await select.waitFor({ timeout: 10000 });
    await a1.route('**/api/patients?*', async (route) => {
      if (route.request().method() === 'GET' && route.request().url().includes('scope=mine')) await wait(2000);
      await route.continue();
    });
    await pullNow(a1); // 'mine' pull을 느리게 시작
    await wait(200);
    await select.selectOption('all');
    await wait(4500);
    await a1.unrouteAll({ behavior: 'ignoreErrors' });
    const counts = sql(`SELECT count(*) FROM patient_records WHERE organization_id = ${q(orgId)} AND deleted_at IS NULL;`);
    await a1.getByRole('button', { name: /작업 목록 돌아가기|환자 목록 보기/ }).first().click().catch(() => {});
    const text = await bodyText(a1);
    const hasB = text.includes(`B환자-${RUN}`);
    record('⑦ 느린 mine pull 중 전체로 바꿈 → 전체 결과(B 환자 포함)가 남음', hasB, `서버 전체 ${counts}명, 화면 ${await listText(a1)}`);
    await a1.getByRole('button', { name: '대시보드' }).click().catch(() => {});
    await a1.locator('.patient-scope-select').selectOption('mine').catch(() => {});
    await wait(2000);
    await a1.getByRole('button', { name: /작업 목록 돌아가기|환자 목록 보기/ }).first().click().catch(() => {});
  });

  await step('⑧(기록, D1 경로) 저장 응답을 기다리는 중 로그아웃 → 같은 계정 재로그인 뒤 편집', async () => {
    await openPatient(a2, P1);
    const lockBefore = await ensureEditable(a2);
    // 요청은 서버로 보내 저장을 끝내고, 응답만 붙잡아 로그아웃 뒤에 클라이언트에 넘긴다(D1: 서버는 새 revision, 클라이언트는 ACK를 못 받음).
    let release;
    const gate = new Promise((r) => { release = r; });
    let serverSaved = false;
    let fetchNote = 'PATCH 없음';
    await a2.route('**/api/patients/*', async (route) => {
      if (route.request().method() !== 'PATCH') { await route.continue(); return; }
      let response;
      try {
        response = await route.fetch();
        fetchNote = `서버 응답 ${response.status()}`;
        serverSaved = response.ok();
      } catch (error) {
        // 서버로 보내지 못했으면 요청을 매달아 두지 않고 그대로 보낸다(다음 시나리오가 막히지 않게).
        fetchNote = `route.fetch 실패: ${String(error?.message || error).split('\n')[0]}`;
        await route.continue().catch(() => {});
        return;
      }
      await gate;
      await route.fulfill({ response }).catch(() => {}); // 로그아웃으로 요청이 취소됐으면 넘길 곳이 없다
    });
    await setActiveName(a2, `동기화환자1D1-${RUN}`);
    await until(() => serverSaved, 10000); // 서버는 저장을 끝냈고 응답은 붙잡혀 있다
    const dbAfter = patientRow(P1);
    await logout(a2, accounts.a);
    release();
    await wait(1500);
    await a2.unrouteAll({ behavior: 'ignoreErrors' });
    await login(a2, accounts.a);
    await openPatient(a2, P1);
    const lockAfter = await ensureEditable(a2);
    const i = a2.__calls.length;
    await setActiveName(a2, `동기화환자1D1재편집-${RUN}`);
    await until(() => callsSince(a2, i, 'PATCH').length > 0, 10000);
    await wait(1500);
    const statuses = callsSince(a2, i, 'PATCH').map((c) => c.status);
    record('⑧(기록) 서버는 저장했고 응답을 기다리는 중 로그아웃 → 재로그인 뒤 다음 저장', null, `서버 저장=${serverSaved && dbAfter?.name === `동기화환자1D1-${RUN}`}(${fetchNote}), 락 ${lockBefore}→${lockAfter}, 재편집 PATCH 상태=${JSON.stringify(statuses)}, 충돌 표시=${(await row(a2, P1).innerText()).includes('Resolve')}`);
  });

  await step('⑨ 오프라인 → 편집 → 온라인 복귀 뒤 저장', async () => {
    await openPatient(a2, P1);
    const lock = await ensureEditable(a2);
    await ctxA2.setOffline(true);
    await setActiveName(a2, `동기화환자1오프-${RUN}`);
    await wait(2500);
    await ctxA2.setOffline(false);
    const i = a2.__calls.length;
    await setActiveName(a2, `동기화환자1온라인-${RUN}`);
    const saved = await until(() => callsSince(a2, i, 'PATCH').some((c) => c.status < 300), 15000);
    await wait(1500);
    record('⑨ 오프라인 편집 → 온라인 뒤 편집 → PATCH 2xx·DB 최신', saved && patientRow(P1)?.name === `동기화환자1온라인-${RUN}`, `락 ${lock}`);
  });

  await step('⑩ 담당 변경 뒤 pull', async () => {
    const p1 = patientRow(P1);
    sql(`UPDATE patient_records SET assigned_doctor_user_id = ${q(accounts.b.id)} WHERE id = ${q(p1.id)};`);
    await pullNow(a1);
    const goneInA1 = await until(async () => (await row(a1, P1).count()) === 0, 15000);
    await pullNow(b1);
    const inB = await until(async () => (await row(b1, P1).count()) > 0, 15000);
    record('⑩ 담당을 B로 바꾸면 A의 내 환자 pull에서 빠지고 B의 pull에 들어옴', goneInA1 && inB, `A=${await listText(a1)} B=${await listText(b1)}`);
  });

  await step('⑪(기록, D2) 일괄 가져오기 뒤 PATCH 수', async () => {
    const existing = await listText(b1);
    const i = b1.__calls.length;
    await b1.getByRole('button', { name: '일괄', exact: true }).first().click(); // 사이드바 "엑셀 일괄입력"
    await b1.locator('input[type="file"]').setInputFiles({ name: 'import.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,patientno\nimported-${RUN},SI-${RUN}\n`) });
    await b1.getByRole('button', { name: '가져오기', exact: true }).click();
    await wait(5000);
    const patches = callsSince(b1, i, 'PATCH').length;
    const posts = callsSince(b1, i, 'POST').filter((c) => c.path === '/api/patients').length;
    record('⑪(기록) 새 환자 1명 가져오기', null, `가져오기 전 ${existing}, PATCH ${patches}회, POST ${posts}회`);
  });

  await step('⑫ 로그아웃 → 같은 계정 재로그인 뒤 목록·저장 상태', async () => {
    const before = await listText(b1);
    await logout(b1, accounts.b);
    await login(b1, accounts.b);
    await pendingGone(b1);
    const after = await listText(b1);
    const serverCount = sql(`SELECT count(*) FROM patient_records WHERE organization_id = ${q(orgId)} AND assigned_doctor_user_id = ${q(accounts.b.id)} AND deleted_at IS NULL;`);
    const noPending = !(await bodyText(b1)).includes('저장 대기');
    record('⑫ 재로그인 뒤 목록 = 서버 내 환자 수, 저장 대기 없음', after === `환자 목록 (${serverCount})` && noPending, `전 ${before} → 후 ${after}, 서버 ${serverCount}`);
  });

  await step('⑬ 저장이 거절되는(403) dirty 환자가 있어도 pull이 1초마다 반복되지 않는다(D3)', async () => {
    await openPatient(b1, PB);
    await ensureEditable(b1);
    // 이 환자의 저장만 403으로 거절한다(권한이 바뀐 상황 흉내 — 서버 데이터는 그대로).
    await b1.route('**/api/patients/*', (route) => (route.request().method() === 'PATCH'
      ? route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"forbidden"}' })
      : route.continue()));
    const before = b1.__calls.length;
    await setActiveName(b1, `B환자-거절-${RUN}`);
    // 의도한 상황을 실제로 지났는지 먼저 확인한다(#349 Codex 권고): 첫 debounce 뒤 PATCH가 403으로 거절되고 이어서 pull이 끝났다.
    const rejected = await until(() => callsSince(b1, before, 'PATCH').some((c) => c.status === 403), 10000);
    // 위치는 걸러내기 전 전체 응답 로그에서 잡는다(#349 Codex 2회차 — PATCH만 남긴 배열의 인덱스를 전체 오프셋으로 쓰면 안 된다).
    const rejectedAt = b1.__calls.findIndex((c, k) => k >= before && c.method === 'PATCH' && c.status === 403);
    const pulledAfter = rejectedAt >= 0
      && await until(() => callsSince(b1, rejectedAt + 1, 'GET').some((c) => c.path === '/api/patients'), 10000);
    await wait(500);
    const i = b1.__calls.length;
    await wait(6000);
    const pulls = callsSince(b1, i, 'GET').filter((c) => c.path === '/api/patients').length;
    const patches = callsSince(b1, i, 'PATCH').length;
    await b1.unrouteAll({ behavior: 'ignoreErrors' });
    // 정리: 다시 편집하면 저장된다(저장이 재개되는지도 판정에 넣는다).
    const j = b1.__calls.length;
    await setActiveName(b1, `B환자-${RUN}`);
    const resumed = await until(() => callsSince(b1, j, 'PATCH').some((c) => c.status < 300), 10000);
    record('⑬ 거절된 dirty 환자가 있어도 6초 동안 pull·PATCH 반복 없음(옮기기 전에는 약 1초마다), 다시 편집하면 저장',
      rejected && pulledAfter && pulls <= 1 && patches <= 1 && resumed,
      `403 거절=${rejected} 뒤 pull=${pulledAfter}, 6초 동안 pull ${pulls}회·PATCH ${patches}회, 재편집 저장=${resumed}`);
  });

  const fiveXX = [a1, a2, b1].flatMap((p) => p.__calls.filter((c) => c.status >= 500 && !(c.injected && c.method === 'PATCH' && c.status === 503)));
  record('5xx 응답 없음(⑤에서 스크립트가 만든 PATCH 503만 제외)', fiveXX.length === 0, JSON.stringify(fiveXX.slice(0, 3)));
}

const browser = await chromium.launch();
try {
  createFixtures();
  console.log(`시험 조직을 만들었습니다(실행 ${RUN}).`);
  await run(browser);
} catch (error) {
  record('스크립트 오류', false, String(error?.message || error).split('\n')[0]);
} finally {
  await browser.close().catch(() => {});
  // 정리 실패·남은 시험 조직은 실패로 기록한다(종료 코드 1 — 시험 데이터가 남았는데 성공으로 보고하지 않게, #341 Codex).
  try {
    if (orgId) deleteOrg(orgId);
    const left = sql(`SELECT count(*) FROM organizations WHERE name = ${q(ORG_NAME)};`);
    const stale = staleOrgIds().length;
    record('정리: 이번 시험 조직 삭제·남은 시험 조직 0', left === '0' && stale === 0, `이번 실행 남음 ${left}, 모든 실행 남음 ${stale}${left === '0' && stale === 0 ? '' : ' — --cleanup-stale로 지우세요'}`);
  } catch (error) {
    record('정리 — 스크립트 오류(--cleanup-stale로 지우세요)', false, String(error?.message || error).split('\n')[0]);
  }
  const failed = results.filter((r) => r.ok === false).length;
  console.log(`\n결과: 통과 ${results.filter((r) => r.ok === true).length} · 실패 ${failed} · 기록 ${results.filter((r) => r.ok === null).length}`);
  process.exitCode = failed ? 1 : 0;
}
