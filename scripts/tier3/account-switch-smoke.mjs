#!/usr/bin/env node
// 계정 전환 실서버 확인(계정 전환 수정 AS-6) — 떠 있는 스택(dev 또는 패키지)에 대해 Playwright(헤드리스 Chromium)로 실제 쿠키·
// 실제 서버를 거쳐 "계정이 바뀌면 작업 공간이 새로 시작되고 이전 계정의 요청·저장이 새 계정에 닿지 않는다"를 확인한다.
// `npm run check`에는 넣지 않는다(스택·DB가 필요).
//
// 시험 조직 1개와 의사 계정 2개(A·B)를 실행마다 무작위 이름·비밀번호로 DB에 만들고, 끝나면(실패해도) finally에서 지운다.
// 저장소에는 계정 값·호스트를 두지 않는다 — 대상은 환경 변수로 받는다:
//   WR_WEB_URL        웹 화면 주소(예: dev는 Vite 개발 서버, 패키지는 리버스 프록시 주소)  — 필수
//   WR_PG_CONTAINER   PostgreSQL 컨테이너 이름(docker exec로 psql 실행)                     — 필수
//   WR_PG_USER, WR_PG_DB  DB 사용자·DB 이름(없으면 개발 기본값)
//   WR_API_BASE       화면 설정의 서버 주소(없으면 '' = 같은 origin)
//   WR_IGNORE_HTTPS_ERRORS=1  자체 서명 인증서(패키지 스택 리허설)
//
// 사용: WR_WEB_URL=… WR_PG_CONTAINER=… node scripts/tier3/account-switch-smoke.mjs
//       WR_PG_CONTAINER=… node scripts/tier3/account-switch-smoke.mjs --cleanup-stale   (이전 실행이 남긴 시험 조직만 지움)
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
// DB(docker exec psql) — 값은 이 스크립트가 만든 무작위 hex·bcrypt 해시뿐이라 따옴표 안에 그대로 넣는다.
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
const ORG_NAME = `tier3-account-switch-${RUN}`;
const accounts = {
  a: { loginId: `t3a-${RUN}`, name: `시험의사A-${RUN}`, password: `Pw-${rand(8)}!a` },
  b: { loginId: `t3b-${RUN}`, name: `시험의사B-${RUN}`, password: `Pw-${rand(8)}!b` },
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

// 시험 조직 하나와 그 조직의 모든 행을 지운다(참조 순서대로). 로그인 실패 기록(login_backoff)은 로그인 ID 해시로만 남고
// 시간이 지나면 풀리므로 건드리지 않는다. 감사 로그는 추가 전용이라 남는다.
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

function deleteFixtures() {
  if (orgId) deleteOrg(orgId);
}

// 이전 실행이 정리하지 못하고 남긴 시험 조직(이 스크립트가 만든 이름 형식)만 지운다.
if (process.argv.includes('--cleanup-stale')) {
  // 이 스크립트가 만드는 이름 형식(접두사 + 소문자 hex 8자리)과 정확히 같고, 사용자가 모두 이 스크립트의 시험 계정 형식인 조직만.
  const stale = sql(`SELECT o.id FROM organizations o
    WHERE o.name ~ '^tier3-account-switch-[0-9a-f]{8}$'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.login_id !~ '^t3[ab]-[0-9a-f]{8}$');`).split('\n').filter(Boolean);
  for (const id of stale) deleteOrg(id);
  console.log(`남아 있던 시험 조직 ${stale.length}개를 지웠습니다.`);
  process.exit(0);
}

const patientsOwnedBy = (acct) => Number(sql(`SELECT count(*) FROM patient_records WHERE owner_user_id = ${q(acct.id)} AND deleted_at IS NULL;`));
const patientNamesOwnedBy = (acct) => sql(`SELECT name FROM patient_records WHERE owner_user_id = ${q(acct.id)} AND deleted_at IS NULL ORDER BY 1;`)
  .split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// 화면 조작
// ---------------------------------------------------------------------------
const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

let lastPage = null;
async function newTab(context) {
  const page = await context.newPage();
  lastPage = page;
  page.on('dialog', (d) => { page.__dialogs.push(d.message()); d.accept(); });
  page.__dialogs = [];
  page.__confirmAnswer = true;
  // 이 탭이 마지막으로 받은 인증 응답의 사용자(로그인·세션 확인). 저장 세션은 탭끼리 공유돼 다른 탭이 덮을 수 있어
  // (한 탭이 로컬로 되돌아가면 공유 저장 세션도 로컬이 된다) 탭별 판정에 쓰지 않는다.
  page.__authUser = null;
  page.on('response', async (res) => {
    if (!/\/api\/auth\/(login|csrf|refresh)$/.test(new URL(res.url()).pathname) || res.status() !== 200) return;
    try { const body = await res.json(); if (body?.user?.id) page.__authUser = body.user.id; } catch { /* 본문 없음 */ }
  });
  await page.goto(WEB_URL);
  return page;
}

async function newContext(browser) {
  const context = await browser.newContext({ ignoreHTTPSErrors: IGNORE_HTTPS });
  // 화면 설정: 인트라넷 모드(운영 설치와 같은 문맥). 자동저장 간격 1초(로컬 전환 뒤 기록 여부 확인용).
  await context.addInitScript(({ apiBase }) => {
    if (!localStorage.getItem('wrEvalUnifiedSettings')) {
      localStorage.setItem('wrEvalUnifiedSettings', JSON.stringify({ integrationMode: 'intranet', apiBaseUrl: apiBase, autoSaveInterval: 1 }));
    }
  }, { apiBase: API_BASE });
  return context;
}

// 확인창 응답을 바꾼다(다음 확인창 하나에만).
function answerNextConfirm(page, accept) {
  page.removeAllListeners('dialog');
  page.on('dialog', (d) => {
    page.__dialogs.push(d.message());
    if (d.type() === 'confirm') {
      if (accept) d.accept(); else d.dismiss();
      answerNextConfirm(page, true);
    } else {
      d.accept();
    }
  });
}

// 서버는 로그인을 IP당 1분에 5회로 제한한다 — 스크립트가 간격을 지키고, 그래도 걸리면(앞 실행 등) 기다렸다가 다시 누른다.
const LOGIN_LIMIT = 4;
const LOGIN_WINDOW_MS = 62_000;
const loginTimes = [];
// 지금 바로 로그인할 수 있을 때까지 기다린다(자리를 쓰지는 않는다) — 시간을 재는 경합 시나리오 앞에서.
async function ensureLoginSlot() {
  for (;;) {
    const now = Date.now();
    while (loginTimes.length && now - loginTimes[0] > LOGIN_WINDOW_MS) loginTimes.shift();
    if (loginTimes.length < LOGIN_LIMIT) return;
    await wait(LOGIN_WINDOW_MS - (now - loginTimes[0]) + 200);
  }
}
async function paceLogin() {
  for (;;) {
    const now = Date.now();
    while (loginTimes.length && now - loginTimes[0] > LOGIN_WINDOW_MS) loginTimes.shift();
    if (loginTimes.length < LOGIN_LIMIT) { loginTimes.push(now); return; }
    await wait(LOGIN_WINDOW_MS - (now - loginTimes[0]) + 200);
  }
}

async function submitLogin(page, acct) {
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
  await page.getByLabel('아이디').fill(acct.loginId);
  await page.getByLabel('비밀번호').fill(acct.password);
  await paceLogin();
  await page.getByRole('button', { name: '로그인', exact: true }).click();
}

async function login(page, acct) {
  await submitLogin(page, acct);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const limited = page.getByText('로그인 시도가 너무 많습니다', { exact: false });
    const outcome = await Promise.race([
      limited.waitFor({ timeout: 8000 }).then(() => 'limited').catch(() => 'none'),
      (async () => { const d = Date.now() + 8000; while (Date.now() < d) { if (!(await onLoginScreen(page))) return 'ok'; await wait(200); } return 'none'; })(),
    ]);
    if (outcome !== 'limited') return;
    await wait(LOGIN_WINDOW_MS);
    await paceLogin();
    await page.getByRole('button', { name: '로그인', exact: true }).click();
  }
}

// 저장 세션의 사용자(탭끼리 공유 — 새 탭이 어떤 세션으로 열릴지 판정할 때만 쓴다).
const sessionUserId = (page) => page.evaluate(() => {
  try { const s = JSON.parse(localStorage.getItem('wrEvalUnifiedAuthSession') || 'null'); return s?.mode === 'intranet' ? s.user?.id ?? null : null; }
  catch { return null; }
});
const onLoginScreen = (page) => page.getByRole('heading', { name: '인트라넷 로그인' }).isVisible().catch(() => false);

async function waitLoggedIn(page, acct) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!(await onLoginScreen(page)) && page.__authUser === acct.id) {
      await page.getByRole('button', { name: /^\+ (추가|새환자)$/ }).first().waitFor({ timeout: 10000 }).catch(() => {});
      return;
    }
    await wait(250);
  }
  throw new Error(`로그인 확인 실패: ${acct.loginId}`);
}

async function isLoggedInAs(page, acct) {
  return !(await onLoginScreen(page)) && page.__authUser === acct.id;
}

async function logout(page, acct) {
  const menu = page.getByRole('button', { name: new RegExp(acct.name) });
  if (await menu.isVisible().catch(() => false)) {
    await menu.click();
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    return;
  }
  // 시작 화면(환자 없음)에는 계정 메뉴가 없다 — 설정 창의 로그아웃.
  await page.getByRole('button', { name: '설정', exact: true }).first().click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).last().click();
}

// 새 환자를 위자드로 만들고 이름을 넣는다(서버는 이름 없는 환자를 받지 않는다).
async function addPatient(page, patientNo, name = `환자-${patientNo}`) {
  const add = page.getByRole('button', { name: /^\+ (추가|새환자)$/ }).first();
  await add.click();
  await page.getByRole('heading', { name: '새 환자 평가' }).waitFor();
  await page.getByPlaceholder('등록번호').fill(patientNo);
  await page.getByRole('button', { name: /다음: 상병 입력/ }).click();
  await page.getByRole('button', { name: /다음: 모듈 선택/ }).click();
  await page.getByRole('checkbox', { name: /어깨/ }).check();
  await page.getByRole('button', { name: /평가 시작/ }).click();
  await page.getByText(new RegExp(`#${patientNo}`)).first().waitFor();
  await setActiveName(page, name);
}

async function setActiveName(page, name) {
  // 기본 정보 단계로 가서 "이름 *" 칸(라벨이 입력과 연결돼 있지 않아 형제 관계로 찾는다).
  await page.getByText('기본정보', { exact: true }).first().click();
  const input = page.locator('xpath=//label[normalize-space()="이름 *"]/following-sibling::input[1]').first();
  await input.fill(name);
}

// 같은 브라우저의 새 탭을 로그인 화면으로 연다 — 저장 세션을 공유하므로 이미 로그인된 상태로 열리면, 이 탭의 저장 세션만
// 지우고 다시 연다(쿠키는 그대로 — 사용자가 다른 탭에서 로그인 화면을 연 상황).
async function newTabOnLoginScreen(context) {
  const page = await newTab(context);
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !(await onLoginScreen(page)) && (await sessionUserId(page)) === null) await wait(250);
  if (!(await onLoginScreen(page))) {
    await page.evaluate(() => { localStorage.removeItem('wrEvalUnifiedAuthSession'); });
    await page.reload();
  }
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 15000 });
  return page;
}

const patientListText = (page) => page.getByText(/^환자 목록 \(\d+\)$/).first().textContent({ timeout: 2000 }).catch(() => null);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 서버에 저장될 때까지(저장 상태가 사라질 때까지) 넉넉히 기다린다.
async function settleSync() { await wait(3000); }

// ---------------------------------------------------------------------------
// 시나리오
// ---------------------------------------------------------------------------
async function scenario1and2(browser) {
  // ① A 로그인·편집(저장 대기) → 로그아웃 확인창 취소·수락 ② 이어서 B 로그인: A의 환자가 B 이름으로 생기지 않음
  const context = await newContext(browser);
  const page = await newTab(context);
  await login(page, accounts.a);
  await waitLoggedIn(page, accounts.a);
  await addPatient(page, `A1-${RUN}`, `A환자-${RUN}`);
  await settleSync();
  const aOwned = patientsOwnedBy(accounts.a);
  record('① A의 환자가 서버에 A 소유로 저장됨', aOwned >= 1, `A 소유 ${aOwned}`);

  // 저장 대기 상태: 저장 요청을 막아 둔다.
  await page.route('**/api/patients/**', (route) => (['PATCH', 'POST'].includes(route.request().method()) ? new Promise(() => {}) : route.continue()));
  await page.route('**/api/patients', (route) => (route.request().method() === 'POST' ? new Promise(() => {}) : route.continue()));
  await setActiveName(page, `A환자-수정-${RUN}`);
  await wait(1500);
  answerNextConfirm(page, false);
  await logout(page, accounts.a);
  await wait(800);
  const stillA = await isLoggedInAs(page, accounts.a);
  record('① 저장되지 않은 환자가 있으면 묻고, 취소하면 로그인 상태 유지', stillA && page.__dialogs.some((m) => m.includes('저장되지 않은 환자')));
  answerNextConfirm(page, true);
  await logout(page, accounts.a);
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
  record('① 확인하면 로그아웃', true);
  await page.unrouteAll({ behavior: 'ignoreErrors' });

  await login(page, accounts.b);
  await waitLoggedIn(page, accounts.b);
  await settleSync();
  const shown = await page.getByText(`A환자-수정-${RUN}`).count() + await page.getByText(`A환자-${RUN}`).count();
  const bNames = patientNamesOwnedBy(accounts.b);
  record('② A 로그아웃 → B 로그인: 화면에 A의 환자 없음', shown === 0);
  record('② 서버에 A의 환자가 B 소유로 생기지 않음', !bNames.some((n) => n && n.startsWith('A환자')), `B 소유 ${bNames.length}`);
  await logout(page, accounts.b);
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
  return { context, page };
}

async function scenario3(browser) {
  // ③ 세션 만료 흉내(쿠키 삭제 + 다음 요청 401) → 같은 A 재로그인: 목록 유지·저장 재개
  const context = await newContext(browser);
  const page = await newTab(context);
  await login(page, accounts.a);
  await waitLoggedIn(page, accounts.a);
  await addPatient(page, `A3-${RUN}`, `A환자3-${RUN}`); // 이 시나리오의 환자(앞 시나리오와 독립)
  await settleSync();
  const before = await patientListText(page);
  // 쿠키를 지우고(갱신 쿠키 만료) 다음 환자 조회 하나를 401로(액세스 토큰 만료) — 인증 갱신이 실패해 로그인 화면으로 간다.
  await context.clearCookies();
  let expired = false;
  await page.route('**/api/patients**', (route) => {
    if (!expired && route.request().method() === 'GET') {
      expired = true;
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ code: 'UNAUTHORIZED' }) });
    }
    return route.continue();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 20000 }).catch(() => {});
  const onLogin = await page.getByRole('heading', { name: '인트라넷 로그인' }).isVisible();
  if (!onLogin) {
    record('③ 세션 만료 흉내 → 로그인 화면', false, '로그인 화면이 뜨지 않음(토큰이 아직 유효 — 다음 갱신까지 기다려야 함)');
    await context.close();
    return;
  }
  await login(page, accounts.a);
  await waitLoggedIn(page, accounts.a);
  const after = await patientListText(page);
  record('③ 같은 A 재로그인: 목록 유지', before !== null && before === after, `${before} → ${after}`);
  await setActiveName(page, `A환자-재개-${RUN}`);
  // 이전 세션(다른 브라우저)이 잡은 편집 락은 만료(100초)까지 남는다 — 그 뒤 락을 다시 얻고 저장한다(기존 락 동작).
  // 포커스 신호로 락 재시도를 앞당기며 최대 약 160초 기다린다.
  const resumed = await (async () => {
    const deadline = Date.now() + 160_000;
    while (Date.now() < deadline) {
      if (patientNamesOwnedBy(accounts.a).includes(`A환자-재개-${RUN}`)) return true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus'))).catch(() => {});
      await wait(5000);
    }
    return false;
  })();
  record('③ 저장 재개(새 세션으로 저장, 이전 락 만료 뒤)', resumed);
  if (!resumed && process.env.WR_ARTIFACT_DIR) {
    await page.screenshot({ path: path.join(process.env.WR_ARTIFACT_DIR, `scenario3-${RUN}.png`), fullPage: true }).catch(() => {});
    (await import('node:fs')).writeFileSync(path.join(process.env.WR_ARTIFACT_DIR, `scenario3-${RUN}.txt`), await page.evaluate(() => document.body.innerText).catch(() => ''));
  }
  await context.close();
}

async function scenario4(browser) {
  // ④ 로그아웃 → 로컬 전환: 빈 화면, 자동저장 키 없음
  const context = await newContext(browser);
  const page = await newTab(context);
  await login(page, accounts.a);
  await waitLoggedIn(page, accounts.a);
  await page.getByText(/^환자 목록 \(\d+\)$/).first().waitFor({ timeout: 15000 }).catch(() => {});
  answerNextConfirm(page, true);
  await logout(page, accounts.a);
  await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
  await page.getByRole('button', { name: /로컬 모드로 전환/ }).click();
  await wait(2500);
  const list = await patientListText(page);
  const autosave = await page.evaluate(() => localStorage.getItem('wrEvalUnifiedAutoSave'));
  record('④ 로그아웃 → 로컬 전환: 이전 목록 없음', list === null, String(list));
  record('④ 로컬 자동저장 키에 기록 없음', autosave === null);
  await context.close();
}

async function scenario5(browser) {
  // ⑤ 같은 브라우저 두 탭 A/B: 먼저 쓰던 탭이 로그인 화면으로, 서버에 섞인 저장 없음
  const context = await newContext(browser);
  const tab1 = await newTab(context);
  await login(tab1, accounts.a);
  await waitLoggedIn(tab1, accounts.a);
  const bBefore = patientNamesOwnedBy(accounts.b);
  const tab2 = await newTabOnLoginScreen(context);
  await login(tab2, accounts.b);
  await waitLoggedIn(tab2, accounts.b);
  await tab1.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 10000 }).catch(() => {});
  record('⑤ 다른 탭이 B로 로그인 → 먼저 쓰던 A 탭은 로그인 화면으로', await tab1.getByRole('heading', { name: '인트라넷 로그인' }).isVisible());
  await settleSync();
  const bAfter = patientNamesOwnedBy(accounts.b);
  record('⑤ 서버에 섞인 저장 없음(B 소유 목록에 A 환자 없음)', !bAfter.some((n) => n && n.startsWith('A환자')) && bAfter.length === bBefore.length, `${bBefore.length} → ${bAfter.length}`);
  await context.close();
}

async function scenario6(browser) {
  // ⑥ 실제 쿠키로 확인하는 경합(응답 지연)
  // (a) A의 로그아웃 응답을 제한 시간(2.5초)보다 길게 늦춘 채 다른 탭에서 B 로그인 → 늦은 응답 뒤에도 B의 쿠키가 남고 B가 계속 저장
  {
    const context = await newContext(browser);
    const tabA = await newTab(context);
    await login(tabA, accounts.a);
    await waitLoggedIn(tabA, accounts.a);
    let releaseLogout;
    await tabA.route('**/api/auth/logout', async (route) => { await new Promise((r) => { releaseLogout = r; }); await route.continue().catch(() => {}); });
    answerNextConfirm(tabA, true);
    await logout(tabA, accounts.a);
    await wait(300);
    const tabB = await newTabOnLoginScreen(context);
    await login(tabB, accounts.b);
    await waitLoggedIn(tabB, accounts.b);
    await wait(3000); // 제한 시간을 넘긴다 — A의 로그아웃 요청은 이미 취소됐어야 한다
    releaseLogout?.();
    await wait(1000);
    await addPatient(tabB, `B6a-${RUN}`);
    await settleSync();
    record('⑥(a) 늦은 로그아웃 응답 뒤에도 B가 계속 저장', patientsOwnedBy(accounts.b) >= 1 && await isLoggedInAs(tabB, accounts.b));
    await context.close();
  }
  // (b) 다른 탭에서 B가 로그인한 직후 A의 로그아웃 응답이 제한 시간 안에 도착 → B의 쿠키가 남는지 기록(잔여 위험), 지워졌어도
  //     B가 다시 로그인하면 편집이 남고 섞인 저장이 없음
  {
    const context = await newContext(browser);
    // B 탭은 A가 로그인하기 전에 로그인 화면으로 열어 둔다(A의 저장 세션으로 열었다 바로 닫으면 탭 간 갱신 조율이 끊겨
    // A 탭까지 로그아웃될 수 있다 — 이 시나리오가 보려는 것과 무관한 상황).
    const tabB = await newTab(context);
    await tabB.getByRole('heading', { name: '인트라넷 로그인' }).waitFor({ timeout: 15000 });
    const tabA = await newTab(context);
    await login(tabA, accounts.a);
    await waitLoggedIn(tabA, accounts.a);
    let releaseLogout;
    let logoutSentAt = 0;
    await tabA.route('**/api/auth/logout', async (route) => {
      logoutSentAt = Date.now();
      await new Promise((r) => { releaseLogout = r; });
      await route.continue().catch(() => {});
    });
    // 경합을 시작하기 전에 로그인 자리를 준비한다 — 그 사이 대기가 끼면 제한 시간을 넘긴다.
    await ensureLoginSlot();
    answerNextConfirm(tabA, true);
    await logout(tabA, accounts.a);
    const sentDeadline = Date.now() + 2000;
    while (!logoutSentAt && Date.now() < sentDeadline) await wait(20);
    // (A의 로그아웃 방송으로 B 탭의 로그인 화면이 다시 그려질 수 있어, 입력은 로그아웃 뒤에 — 수십 ms)
    await tabB.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
    await tabB.getByLabel('아이디').fill(accounts.b.loginId);
    await tabB.getByLabel('비밀번호').fill(accounts.b.password);
    await paceLogin();
    await tabB.getByRole('button', { name: '로그인', exact: true }).click();
    await waitLoggedIn(tabB, accounts.b);
    const elapsed = logoutSentAt ? Date.now() - logoutSentAt : Infinity;
    releaseLogout?.();
    await wait(1500);
    const cookies = await context.cookies();
    const hasRefresh = cookies.some((c) => /refresh/i.test(c.name));
    // 제한 시간(2.5초) 안에 놓아줬을 때만 이 경합을 확인한 것이다.
    record('⑥(b) 이전 계정의 로그아웃 응답을 제한 시간 안에 도착시킴', elapsed < 2400, `${elapsed}ms`);
    record('⑥(b) [기록] 그 뒤 B의 갱신 쿠키', true, hasRefresh ? '남음' : '지워짐(잔여 위험 — 가용성)');
    const bBefore = patientNamesOwnedBy(accounts.b);
    await addPatient(tabB, `B6b-${RUN}`).catch(() => {});
    await settleSync();
    if (await tabB.getByRole('heading', { name: '인트라넷 로그인' }).isVisible().catch(() => false)) {
      await login(tabB, accounts.b);
      await waitLoggedIn(tabB, accounts.b);
      await settleSync();
    }
    const bAfter = patientNamesOwnedBy(accounts.b);
    record('⑥(b) 섞인 저장 없음(B 소유에 A 환자 없음)', !bAfter.some((n) => n && n.startsWith('A환자')), `${bBefore.length} → ${bAfter.length}`);
    await context.close();
  }
  // (c) A의 로그인 응답을 늦춘 채 로컬 전환 → 응답이 와도 쿠키·화면이 바뀌지 않음
  {
    const context = await newContext(browser);
    const page = await newTab(context);
    let releaseLogin;
    await page.route('**/api/auth/login', async (route) => { await new Promise((r) => { releaseLogin = r; }); await route.continue().catch(() => {}); });
    await page.getByRole('heading', { name: '인트라넷 로그인' }).waitFor();
    await page.getByLabel('아이디').fill(accounts.a.loginId);
    await page.getByLabel('비밀번호').fill(accounts.a.password);
    await paceLogin();
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await wait(300);
    const disabled = await page.getByRole('button', { name: /로컬 모드로 전환/ }).isDisabled();
    record('⑥(c) 로그인 응답을 기다리는 동안 "로컬 모드로 전환"이 막혀 있음', disabled);
    // 버튼이 막혀 있으므로 응답을 놓아준 뒤에는 정상 로그인된다(세대 검사 자체는 자동 테스트 R18이 고정)
    releaseLogin?.();
    await waitLoggedIn(page, accounts.a);
    record('⑥(c) 응답이 오면 정상 로그인', true);
    await context.close();
  }
  // (d) 응답이 이미 도착한 뒤 버려진 로그인(쿠키만 바뀜) → 새로고침해도 그 계정으로 열리지 않음
  {
    const context = await newContext(browser);
    const page = await newTab(context);
    await login(page, accounts.a);
    await waitLoggedIn(page, accounts.a);
    // 다른 계정 쿠키로 바꿔치기: 같은 컨텍스트의 요청으로 B 로그인(화면에는 적용하지 않음)
    let status = 0;
    for (let attempt = 0; attempt < 2 && status !== 200; attempt += 1) {
      if (attempt > 0) await wait(LOGIN_WINDOW_MS); // 로그인 제한(429)이면 한 번 기다렸다가 다시
      await paceLogin();
      status = await page.evaluate(async ({ loginId, password, apiBase }) => {
        const res = await fetch(`${apiBase}/api/auth/login`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ loginId, password, rememberMe: true }) });
        return res.status;
      }, { loginId: accounts.b.loginId, password: accounts.b.password, apiBase: API_BASE });
      if (status !== 429) break;
    }
    // B 로그인이 성공해야(쿠키가 B 것으로 바뀌어야) 버려진 로그인 상황이 만들어진 것이다.
    record('⑥(d) 버려진 로그인 상황 만들기(쿠키만 B로 로그인)', status === 200, `login ${status}`);
    await page.reload();
    await wait(3000);
    const showsB = await isLoggedInAs(page, accounts.b);
    const showsA = await isLoggedInAs(page, accounts.a);
    record('⑥(d) 버려진 로그인(쿠키만 B) → 새로고침해도 B로 열리지 않음', !showsB, `login ${status}, A로 보임=${showsA}`);
    await context.close();
  }
}

// ---------------------------------------------------------------------------
const browser = await chromium.launch({ headless: true });
let exitCode = 0;
try {
  createFixtures();
  console.log(`시험 조직·계정 생성(무작위, 실행 ${RUN})`);
  // WR_ONLY=3,6 처럼 일부만(진단용). 없으면 전부.
  const only = (process.env.WR_ONLY || '').split(',').map((v) => v.trim()).filter(Boolean);
  const runs = (key) => only.length === 0 || only.includes(key);
  if (runs('1') || runs('2')) { const { context } = await scenario1and2(browser); await context.close(); }
  if (runs('3')) await scenario3(browser);
  if (runs('4')) await scenario4(browser);
  if (runs('5')) await scenario5(browser);
  if (runs('6')) await scenario6(browser);
} catch (error) {
  exitCode = 1;
  console.error('ERROR', error?.stack || error);
  // 진단용(선택): WR_ARTIFACT_DIR에 마지막 탭의 화면·텍스트를 남긴다(저장소 밖 경로를 준다).
  if (process.env.WR_ARTIFACT_DIR && lastPage) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    let i = 0;
    for (const pg of pages) {
      i += 1;
      await pg.screenshot({ path: path.join(process.env.WR_ARTIFACT_DIR, `account-switch-${RUN}-tab${i}.png`), fullPage: true }).catch(() => {});
      const text = await pg.evaluate(() => document.body.innerText).catch(() => '');
      (await import('node:fs')).writeFileSync(path.join(process.env.WR_ARTIFACT_DIR, `account-switch-${RUN}-tab${i}.txt`), text);
    }
  }
} finally {
  await browser.close().catch(() => {});
  try {
    deleteFixtures();
    const left = sql(`SELECT count(*) FROM organizations WHERE name = ${q(ORG_NAME)};`);
    console.log(`시험 조직 정리: 남은 수 ${left}`);
    if (left !== '0') exitCode = 1;
  } catch (cleanupError) {
    exitCode = 1;
    console.error('CLEANUP ERROR', cleanupError?.message || cleanupError);
  }
}
const failed = results.filter((r) => !r.ok);
console.log(`\n결과: ${results.length - failed.length}/${results.length} 통과`);
process.exit(failed.length > 0 ? 1 : exitCode);
