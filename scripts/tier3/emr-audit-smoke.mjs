#!/usr/bin/env node
// EMR 감사 기록 전송 경로 실서버 확인(EA-2·EA-9) — 떠 있는 서버(dev 또는 패키지 스택)에 대해 설치본의 감사 코드(audit.js·
// auditQueue.js)를 Node에서 그대로 돌린다. `electron` 모듈만 가짜(app.getPath·safeStorage·net.request)로 바꾸고,
// "PC"와 "앱 재시작"마다 모듈을 새로 불러 전역 상태를 초기화한다. `npm run check`에는 넣지 않는다(서버·DB가 필요).
//
// 설치본 코드
//   legacy  scripts/tier3/fixtures/shell-7.1.4/ — 7.1.4 셸의 감사 코드 사본(커밋 77e6686의 electron/audit.js·
//           auditQueue.js·accessTokenClaims.js와 같은 내용). 시험용이며 설치본에 들어가지 않는다. 고치지 않는다.
//   current electron/ — 지금 설치본의 감사 코드(EA-5 ~ EA-8).
//
// 데이터: 시험 조직 2개와 계정 4개(조직 1의 의사 A·B·관리자, 조직 2의 의사 C)를 실행마다 무작위 이름·비밀번호로 DB에 만들고, 끝나면(실패해도)
// 조직·사용자·세션·장치(장치와 함께 nonce 기록)를 지운다. **감사 로그(audit_logs)는 추가 전용이라 이 실행이 남긴
// 행은 지울 수 없고 남는다**(시험 조직 ID가 행위자 기관으로 남는다). 저장소에는 계정 값·호스트를 두지 않는다.
//
// 등록 API는 IP당 분당 1회만 받는다 — 이 스크립트는 등록을 부를 수 있는 단계 사이에 61초를 기다린다.
//
// 환경 변수
//   WR_API_URL        서버 주소(예: dev 서버, 패키지 스택의 리버스 프록시 주소)       — 필수
//   WR_PG_CONTAINER   PostgreSQL 컨테이너 이름(docker exec로 psql 실행)             — 필수
//   WR_PG_USER, WR_PG_DB  DB 사용자·DB 이름(없으면 개발 기본값)
//   WR_IGNORE_HTTPS_ERRORS=1  자체 서명 인증서(패키지 스택 리허설)
// 옵션
//   --queue N        대기열에 미리 쌓아 둘 기록 수(기본 150). 1,000건 이상은 패키지(일회용) 스택에서만.
//   --shell legacy|current|both  돌릴 설치본 코드(기본 both). current는 약 5분 걸린다(등록 제한·429 대기).
//   --old-server     현재 설치본 코드를 이전 서버(7.3.1)에 대해 — 대기열에 남는지까지. --keep-state 파일과 함께 쓰면
//                    시험 계정·PC 폴더를 남기고, 서버를 다시 올린 뒤 --resume-state 파일로 대기열이 들어가는지 확인하고 정리한다.
//   --cleanup-stale  이전 실행이 남긴 시험 조직만 지운다.
//
// 사용: WR_API_URL=… WR_PG_CONTAINER=… node scripts/tier3/emr-audit-smoke.mjs [--queue 150]
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);
const requireFromServer = createRequire(path.join(ROOT, 'server', 'package.json'));
const bcrypt = requireFromServer('bcrypt');

const API_URL = (process.env.WR_API_URL || '').replace(/\/$/, '');
const PG_CONTAINER = process.env.WR_PG_CONTAINER;
const PG_USER = process.env.WR_PG_USER || 'wr_user';
const PG_DB = process.env.WR_PG_DB || 'wr_evaluation';
const INSECURE = process.env.WR_IGNORE_HTTPS_ERRORS === '1';
const argValue = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const QUEUE_SIZE = Number(argValue('--queue', '150'));
const SHELL_MODE = argValue('--shell', 'both');
const OLD_SERVER = process.argv.includes('--old-server');
const KEEP_STATE = argValue('--keep-state', null);
const RESUME_STATE = argValue('--resume-state', null);
if (!['legacy', 'current', 'both'].includes(SHELL_MODE)) {
  console.error('--shell은 legacy·current·both 가운데 하나입니다.');
  process.exit(2);
}
if (!PG_CONTAINER || (!API_URL && !process.argv.includes('--cleanup-stale'))) {
  console.error('WR_API_URL과 WR_PG_CONTAINER가 필요합니다(스크립트 머리말 참고).');
  process.exit(2);
}
if (!Number.isInteger(QUEUE_SIZE) || QUEUE_SIZE < 1) {
  console.error('--queue는 1 이상의 정수여야 합니다.');
  process.exit(2);
}

const LEGACY_DIR = path.join(ROOT, 'scripts', 'tier3', 'fixtures', 'shell-7.1.4');
const ELECTRON_UA = 'Mozilla/5.0 (Windows NT 6.1) wr-evaluation-unified-tier3 Electron/22.3.27';

// ---------------------------------------------------------------------------
// DB(docker exec psql) — 값은 이 스크립트가 만든 무작위 hex·UUID·bcrypt 해시뿐이다.
// ---------------------------------------------------------------------------
function sql(statement) {
  return execFileSync('docker', ['exec', '-i', PG_CONTAINER, 'psql', '-U', PG_USER, '-d', PG_DB, '-At', '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    input: statement, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, // 대량 대기열(수천 건)의 감사 행 JSON
  }).trim();
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rand = (n = 6) => randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const saved = RESUME_STATE ? JSON.parse(fs.readFileSync(RESUME_STATE, 'utf8')) : null;
const RUN = saved?.run ?? rand(4);
const ORG_NAME = `tier3-emr-audit-${RUN}`;
const ORG2_NAME = `tier3-emr-audit-${RUN}-o2`;
const accounts = saved?.accounts ?? {
  a: { loginId: `t3ea-${RUN}`, name: `시험의사A-${RUN}`, role: 'doctor', password: `Pw-${rand(8)}!a` },
  b: { loginId: `t3eb-${RUN}`, name: `시험의사B-${RUN}`, role: 'doctor', password: `Pw-${rand(8)}!b` },
  admin: { loginId: `t3em-${RUN}`, name: `시험관리자-${RUN}`, role: 'admin', password: `Pw-${rand(8)}!m` },
  c: { loginId: `t3ec-${RUN}`, name: `시험의사C-${RUN}`, role: 'doctor', password: `Pw-${rand(8)}!c`, org2: true },
};
let orgId = saved?.orgId ?? null;
let org2Id = saved?.org2Id ?? null;

function createFixtures() {
  orgId = sql(`INSERT INTO organizations (name) VALUES (${q(ORG_NAME)}) RETURNING id;`).split('\n')[0];
  org2Id = sql(`INSERT INTO organizations (name) VALUES (${q(ORG2_NAME)}) RETURNING id;`).split('\n')[0];
  for (const acct of Object.values(accounts)) {
    const hash = bcrypt.hashSync(acct.password, 10);
    acct.id = sql(`INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
      VALUES (${q(acct.loginId)}, ${q(hash)}, ${q(acct.name)}, ${q(acct.role)}, ${q(acct.org2 ? org2Id : orgId)}, false) RETURNING id;`).split('\n')[0];
  }
}

// 시험 조직과 그 행을 지운다. 장치를 지우면 emr_audit_nonces가, 사용자를 지우면 세션이 함께 지워진다.
function deleteOrg(id) {
  const o = q(id);
  sql(`BEGIN;
    DELETE FROM devices WHERE organization_id = ${o} OR user_id IN (SELECT id FROM users WHERE organization_id = ${o});
    DELETE FROM autosaves WHERE organization_id = ${o} OR user_id IN (SELECT id FROM users WHERE organization_id = ${o});
    DELETE FROM users WHERE organization_id = ${o};
    DELETE FROM organizations WHERE id = ${o};
    COMMIT;`);
}

if (process.argv.includes('--cleanup-stale')) {
  const stale = sql(`SELECT o.id FROM organizations o
    WHERE o.name ~ '^tier3-emr-audit-[0-9a-f]{8}(-o2)?$'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.login_id !~ '^t3e[abmc]-[0-9a-f]{8}$');`).split('\n').filter(Boolean);
  for (const id of stale) deleteOrg(id);
  console.log(`남아 있던 시험 조직 ${stale.length}개를 지웠습니다.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// HTTP(시험 준비용 — 로그인·승인)
// ---------------------------------------------------------------------------
function httpJson(method, url, { headers = {}, body } = {}) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': ELECTRON_UA, ...headers },
      rejectUnauthorized: !INSECURE,
    }, (res) => {
      let data = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { /* 본문 없음 */ }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function login(acct) {
  const res = await httpJson('POST', `${API_URL}/api/auth/login`, { body: { loginId: acct.loginId, password: acct.password } });
  if (res.status !== 200 || !res.body?.accessToken) throw new Error(`로그인 실패(${acct.loginId}): HTTP ${res.status}`);
  const cookie = [].concat(res.headers['set-cookie'] ?? []).find((c) => c.startsWith('wr_csrf='));
  acct.token = res.body.accessToken;
  acct.csrf = cookie ? decodeURIComponent(cookie.split(';')[0].slice('wr_csrf='.length)) : null;
}

async function approve(deviceId) {
  const res = await httpJson('POST', `${API_URL}/api/admin/devices/${deviceId}/approve`, {
    headers: { Authorization: `Bearer ${accounts.admin.token}`, 'X-CSRF-Token': accounts.admin.csrf ?? '' },
    body: {},
  });
  return res;
}

// ---------------------------------------------------------------------------
// 가짜 electron(scripts/lib/fakeElectron.cjs) — "PC" 하나 = userData 폴더 하나. net.request는 여기서 실제 HTTP로 보낸다.
// ---------------------------------------------------------------------------
const { createFakeElectron, loadShellModule } = require(path.join(ROOT, 'scripts', 'lib', 'fakeElectron.cjs'));
const requestLog = []; // { at, path, status, ms }

function realSend({ url, method, headers, body }) {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const req = mod.request(u, {
      method,
      headers: { 'User-Agent': ELECTRON_UA, ...headers, 'Content-Length': body.length },
      rejectUnauthorized: !INSECURE,
    }, (res) => {
      let data = '';
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('response aborted')));
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        requestLog.push({ at: started, path: u.pathname, status: res.statusCode, ms: Date.now() - started });
        resolve({ status: res.statusCode, body: data, headers: res.headers });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

/** 설치본 감사 코드를 새로 불러온다(= 앱 시작). 같은 폴더의 모듈 캐시를 비워 전역 상태를 초기화한다. */
function startShell(shellDir, pc) {
  const fake = createFakeElectron({ userDataDir: pc.dir, send: realSend });
  const audit = loadShellModule(shellDir, 'audit.js', fake);
  const queue = require(path.join(shellDir, 'auditQueue.js')); // audit.js가 불러 둔 같은 인스턴스
  return { audit, queue };
}

function newPc(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wr-t3-emr-${label}-`));
  return { label, dir, meta: () => JSON.parse(fs.readFileSync(path.join(dir, 'wr-device.json'), 'utf8')) };
}
const queueLines = (pc) => {
  const file = path.join(pc.dir, 'audit-emr-pending.enc');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).length : 0;
};

// 등록 API(IP당 분당 1회) 앞에서 기다린다.
let lastRegisterAt = 0;
async function waitRegisterWindow() {
  const wait = lastRegisterAt + 61_000 - Date.now();
  if (wait > 0) {
    console.log(`  (등록 제한 — ${Math.ceil(wait / 1000)}초 기다림)`);
    await sleep(wait);
  }
  lastRegisterAt = Date.now();
}

// ---------------------------------------------------------------------------
// 판정
// ---------------------------------------------------------------------------
const results = [];
const measured = {};
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const emrRows = (where) => sql(`SELECT json_agg(t) FROM (
    SELECT actor_user_id, actor_org_id, action, outcome, target_type, extra, created_at
      FROM audit_logs WHERE target_type = 'emr' AND actor_org_id = ${q(orgId)} AND extra->>'t3run' = ${q(RUN)} ${where}
     ORDER BY created_at, id) t;`);
const rowsWhere = (where) => JSON.parse(emrRows(where) || 'null') ?? [];
const seqRows = (seq) => rowsWhere(`AND extra->>'seq' = ${q(seq)}`);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const entry = (seq, extra = {}) => ({ action: 'emr_extract_record', outcome: 'failure', targetId: sha(`t3-${RUN}-${seq}`), extra: { t3run: RUN, seq, ...extra } });

// ---------------------------------------------------------------------------
// 시나리오 ①: 7.1.4 설치본 사본
// ---------------------------------------------------------------------------
async function legacyScenario() {
  const tokens = { current: accounts.a.token };
  const getAccessToken = () => tokens.current;
  const pc = newPc('legacy');

  // 1) 첫 실행: 장치 키를 만들고 등록(승인 대기).
  await waitRegisterWindow();
  let shell = startShell(LEGACY_DIR, pc);
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL });
  const localId = pc.meta().deviceId;
  const rows = sql(`SELECT id || '|' || status FROM devices WHERE organization_id = ${q(orgId)};`).split('\n').filter(Boolean);
  record('7.1.4: 첫 실행 → 등록 요청(승인 대기)', shell.audit.getDeviceStatus().status === 'pending' && rows.length === 1 && rows[0].endsWith('|pending'),
    `로컬 상태 ${shell.audit.getDeviceStatus().status}, 서버 행 ${rows.join(',')}`);
  const serverId = rows[0]?.split('|')[0];
  record('7.1.4: 설치본의 장치 ID ≠ 서버 등록 행 ID', Boolean(serverId) && serverId !== localId);

  // 2) 승인 전 EMR 사용 → 대기열에 쌓인다.
  await shell.audit.recordAudit(entry('pending-1'));
  record('7.1.4: 승인 전 기록은 대기열로', queueLines(pc) === 1, `대기열 ${queueLines(pc)}줄`);

  // 3) 관리자 승인.
  const approved = await approve(serverId);
  record('관리자 승인(API)', approved.status === 200, `HTTP ${approved.status}`);

  // 4) 대기열에 N건을 더 쌓는다(쌓인 과거 기록 흉내).
  for (let i = 0; i < QUEUE_SIZE; i += 1) shell.queue.enqueue(entry(`q-${i}`));
  record(`7.1.4: 대기열 ${QUEUE_SIZE + 1}줄 준비`, queueLines(pc) === QUEUE_SIZE + 1);

  // 5) 앱 재시작 → 등록 응답으로 active → 첫 재전송 회차가 대기열 전부를 보낸다.
  await waitRegisterWindow();
  shell = startShell(LEGACY_DIR, pc);
  requestLog.length = 0;
  const t0 = Date.now();
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL });
  const flushMs = Date.now() - t0;
  const auditReqs = requestLog.filter((r) => r.path === '/api/audit/emr');
  const statuses = auditReqs.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {});
  const gaps = auditReqs.slice(1).map((r, i) => r.at - auditReqs[i].at);
  measured.legacyFlush = {
    entries: QUEUE_SIZE + 1, ms: flushMs, perSec: Number(((QUEUE_SIZE + 1) / (flushMs / 1000)).toFixed(1)), statuses,
    gapMs: { max: Math.max(0, ...gaps), median: gaps.sort((x, y) => x - y)[Math.floor(gaps.length / 2)] ?? 0 },
    requestMs: { max: Math.max(0, ...auditReqs.map((r) => r.ms)) },
  };
  record('7.1.4: 재시작 뒤 상태 active', shell.audit.getDeviceStatus().status === 'active');
  record(`7.1.4: 재전송 한 회차에 ${QUEUE_SIZE + 1}건 전부 전송, 대기열 비움`, queueLines(pc) === 0 && statuses[200] === QUEUE_SIZE + 1,
    `${flushMs} ms, 응답 ${JSON.stringify(statuses)}`);

  const queued = rowsWhere(`AND extra->>'seq' LIKE 'q-%'`);
  const pendingRow = seqRows('pending-1');
  record('7.1.4: 쌓인 기록이 감사 로그에 들어감(건수)', queued.length === QUEUE_SIZE && pendingRow.length === 1, `q ${queued.length}, pending ${pendingRow.length}`);
  const all = [...pendingRow, ...queued];
  const okFlags = all.every((r) => r.actor_user_id === accounts.a.id && r.extra.legacy_shell === true && r.extra.occurred_at_unknown === true
    && r.extra.actor_uncertain === true && r.extra.actor_source === 'session_fallback'
    && r.extra.header_device_id === localId && r.extra.deviceId === serverId && r.extra.source === 'electron-main');
  record('7.1.4: 행위자(전송 세션 사용자)와 표시(옛 설치본·불확실·헤더 ID·고정 행 ID)', okFlags);
  const burstCount = all.filter((r) => r.extra.burst === true).length;
  measured.legacyFlush.burstFlagged = burstCount;
  record('7.1.4: 몰아서 보낸 기록에 묶음 표시(첫 건 제외)', burstCount >= all.length - 1, `${burstCount}/${all.length}`);

  // 6) 같은 PC, 같은 기관의 다른 사용자 → 추가 승인 없이 기록되고 행위자는 그 사용자.
  tokens.current = accounts.b.token;
  await shell.audit.recordAudit(entry('live-b'));
  const liveB = seqRows('live-b');
  record('7.1.4: 같은 기관 다른 사용자의 기록(추가 승인 없음)', liveB.length === 1 && liveB[0].actor_user_id === accounts.b.id && queueLines(pc) === 0);

  // 7) 로그인하지 않은 상태(토큰 없음) → 행위자 = PC의 첫 승인 행 등록자, 세션 없음 표시.
  tokens.current = null;
  await shell.audit.recordAudit(entry('live-nosession'));
  const noSession = seqRows('live-nosession');
  record('7.1.4: 세션 없는 기록 → 장치 등록자·세션 없음 표시', noSession.length === 1 && noSession[0].actor_user_id === accounts.a.id
    && noSession[0].extra.session_missing === true && noSession[0].extra.actor_source === 'device_registrant');

  // 8) 재전송 회차 도중의 새 기록이 제한 때문에 실패하지 않는다(옛 설치본은 실패한 새 기록을 회차 끝의 쓰기로 잃을 수 있다).
  tokens.current = accounts.a.token;
  // 회차가 확실히 진행 중일 때 새 기록을 보내도록 대기열을 최소 20건으로 하고, 응답 5건을 받은 뒤(회차가 끝나지 않았을 때) 보낸다.
  // 대량 모드(--queue 300 이상)는 대기열을 --queue만큼 쌓고, 서버가 응답을 늦추기 시작한 뒤(PC별 여유분 소진) 보낸다.
  const paced = QUEUE_SIZE >= 300;
  const overlap = paced ? QUEUE_SIZE : Math.max(20, Math.min(QUEUE_SIZE, 150));
  for (let i = 0; i < overlap; i += 1) shell.queue.enqueue(entry(`overlap-q-${i}`));
  requestLog.length = 0;
  let flushSettled = false;
  const flushing = shell.audit.flushQueue().finally(() => { flushSettled = true; });
  flushing.catch(() => {}); // 실패는 아래 await에서 받는다(처리되지 않은 거부 방지)
  const waitUntil = Date.now() + 30_000;
  const ready = () => (paced
    ? requestLog.some((r) => r.path === '/api/audit/emr' && r.ms >= 80) // 늦춰진 응답(초당 10건 → 100 ms 간격)
    : requestLog.filter((r) => r.path === '/api/audit/emr').length >= 5);
  const waitUntil2 = Date.now() + 120_000;
  while (!ready()) {
    if (paced && Date.now() > waitUntil2) throw new Error('서버가 응답을 늦추기 시작하지 않았습니다(2분)');
    if (flushSettled) throw new Error('재전송 회차가 새 기록을 보내기 전에 끝났습니다(전송 실패 또는 대기열 부족)');
    if (!paced && Date.now() > waitUntil) throw new Error('재전송 회차의 응답을 30초 안에 받지 못했습니다');
    await sleep(5);
  }
  const overlapped = !flushSettled;
  await shell.audit.recordAudit(entry('overlap-live'));
  await flushing;
  record(`7.1.4: 새 기록을 재전송 회차 도중에 보냄${paced ? '(서버가 늦추는 중)' : ''}`, overlapped);
  const live = seqRows('overlap-live');
  const overlapRows = rowsWhere(`AND extra->>'seq' LIKE 'overlap-q-%'`);
  record('7.1.4: 재전송 중의 새 기록이 한 건 기록됨', live.length === 1, `${live.length}건`);
  record('7.1.4: 재전송 중 대기열 전부 기록, 대기열 비움', overlapRows.length === overlap && queueLines(pc) === 0,
    `${overlapRows.length}/${overlap}, 대기열 ${queueLines(pc)}줄, 응답 ${JSON.stringify(requestLog.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}))}`);

  fs.rmSync(pc.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 시나리오 ②: 현재 설치본 코드(electron/)
// ---------------------------------------------------------------------------
const CURRENT_DIR = path.join(ROOT, 'electron');

async function revoke(deviceId) {
  return httpJson('POST', `${API_URL}/api/admin/devices/${deviceId}/revoke`, {
    headers: { Authorization: `Bearer ${accounts.admin.token}`, 'X-CSRF-Token': accounts.admin.csrf ?? '' },
    body: {},
  });
}

// 감사 요청 120건을 일부러 실패시켜(UUID가 아닌 장치 ID) 이 주소의 실패 한도를 채운다 — 다음 요청부터 429.
async function exhaustAddressLimit() {
  const body = { action: 'emr_inject', outcome: 'failure' };
  for (let i = 0; i < 120; i += 1) {
    await httpJson('POST', `${API_URL}/api/audit/emr`, {
      headers: {
        'X-WR-Source': 'electron-main', 'X-WR-Device-Id': 'not-a-uuid', 'X-WR-Device-Sig': 'AA==',
        'X-WR-Device-Ts': new Date().toISOString(), 'X-WR-Device-Nonce': randomUUID(),
      },
      body,
    });
  }
}

const deviceRowsOfOrg = () => sql(`SELECT id || '|' || status || '|' || user_id FROM devices WHERE organization_id = ${q(orgId)} ORDER BY registered_at;`)
  .split('\n').filter(Boolean).map((l) => { const [id, status, userId] = l.split('|'); return { id, status, userId }; });

async function currentScenario() {
  const tokens = { current: accounts.a.token };
  const getAccessToken = () => tokens.current;
  const pc = newPc('current');
  const before = deviceRowsOfOrg().length;

  // 1) 첫 실행(의사 A): 장치 키를 만들고 상태를 묻는다 → 새 키라 승인 대기 행.
  await waitRegisterWindow();
  let shell = startShell(CURRENT_DIR, pc);
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL });
  let rows = deviceRowsOfOrg().slice(before);
  record('현재: 첫 실행 → 승인 대기, 게이트 닫힘', rows.length === 1 && rows[0].status === 'pending'
    && shell.audit.getEmrGate().reason === 'pending' && pc.meta().pc?.status === 'pending' && pc.meta().pc?.orgId === orgId,
  `${JSON.stringify(shell.audit.getEmrGate())}, pc ${JSON.stringify(pc.meta().pc)}`);
  const serverId = rows[0]?.id;

  // 2) 승인 전 EMR 사용(A) → 대기열(시작 때의 사용자·시각).
  const ctxPending = shell.audit.captureAuditContext();
  await shell.audit.recordAudit(entry('cur-pending'), ctxPending);
  record('현재: 승인 전 기록은 대기열로', queueLines(pc) === 1);

  // 3) 승인 → 재시작(이번에는 같은 기관의 의사 B로 로그인) → 첫 토큰에서 PC 상태 확인(새 행 없음) → 대기열 전송.
  expect200(await approve(serverId), '관리자 승인(API)');
  tokens.current = accounts.b.token;
  await waitRegisterWindow();
  shell = startShell(CURRENT_DIR, pc);
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL });
  rows = deviceRowsOfOrg().slice(before);
  record('현재: 같은 기관 다른 사용자 — 새 등록 행 없이 열림', rows.length === 1 && shell.audit.getEmrGate().allowed === true,
    `행 ${rows.length}, ${JSON.stringify(shell.audit.getEmrGate())}`);
  const queued = seqRows('cur-pending');
  record('현재: 대기열을 거친 기록 = 시작한 사용자(A)·시작 시각, 미검증·전송자 B·queued', queued.length === 1
    && queued[0].actor_user_id === accounts.a.id && queued[0].extra.actor_source === 'device_claim' && queued[0].extra.actor_unverified === true
    && queued[0].extra.sent_by_user_id === accounts.b.id && queued[0].extra.occurred_at === ctxPending.occurredAt
    && queued[0].extra.queued === true && queued[0].extra.eventId === ctxPending.eventId && queueLines(pc) === 0,
  JSON.stringify(queued[0]?.extra ?? null));

  // 4) B의 EMR 사용 → 세션 사용자로 확인된 행위자.
  await shell.audit.recordAudit(entry('cur-live-b'), shell.audit.captureAuditContext());
  const liveB = seqRows('cur-live-b');
  record('현재: 실시간 기록 = 세션 사용자(B), 불확실 표시 없음', liveB.length === 1 && liveB[0].actor_user_id === accounts.b.id
    && liveB[0].extra.actor_source === 'session' && !liveB[0].extra.actor_uncertain && !liveB[0].extra.legacy_shell
    && typeof liveB[0].extra.occurred_at === 'string' && liveB[0].extra.header_device_id === pc.meta().deviceId && liveB[0].extra.deviceId === serverId);

  // 5) 동작 도중 계정 전환(B로 시작 → A로 바뀐 뒤 기록) → 시작한 사용자(B).
  const ctxB = shell.audit.captureAuditContext();
  tokens.current = accounts.a.token;
  await shell.audit.recordAudit(entry('cur-switch'), ctxB);
  const sw = seqRows('cur-switch');
  record('현재: 동작 도중 계정이 바뀌어도 시작한 사용자로 기록', sw.length === 1 && sw[0].actor_user_id === accounts.b.id
    && sw[0].extra.sent_by_user_id === accounts.a.id);

  // 5-1) 같은 기록을 두 번 보냄(같은 기록 시점 정보 = 같은 eventId, 요청마다 새 nonce — 응답을 받지 못해 대기열 줄을 다시
  //      보낸 경우와 같음) → 둘 다 받아들여지고(대기열에 남지 않음) 감사 행은 하나(FX-6).
  const ctxDup = shell.audit.captureAuditContext();
  await shell.audit.recordAudit(entry('cur-dup'), ctxDup);
  await shell.audit.recordAudit(entry('cur-dup'), ctxDup);
  const dup = seqRows('cur-dup');
  record('현재: 같은 기록을 두 번 보내면 감사 행은 하나, 대기열 0', dup.length === 1 && dup[0].extra.eventId === ctxDup.eventId
    && queueLines(pc) === 0, `행 ${dup.length}, 대기열 ${queueLines(pc)}`);

  // 6) 429에서 회차를 멈춘다(이 주소의 실패 한도를 채운 뒤) → Retry-After 동안 다음 회차 없음 → 지난 뒤 전부 전송.
  for (let i = 0; i < 5; i += 1) shell.queue.enqueue(entry(`cur-429-${i}`));
  await exhaustAddressLimit();
  requestLog.length = 0;
  await shell.audit.flushQueue();
  const firstRound = requestLog.filter((r) => r.path === '/api/audit/emr');
  record('현재: 429 → 회차를 멈추고 남김', firstRound.length === 1 && firstRound[0].status === 429 && queueLines(pc) === 5,
    `요청 ${firstRound.map((r) => r.status).join(',')}, 대기열 ${queueLines(pc)}`);
  requestLog.length = 0;
  await shell.audit.flushQueue();
  record('현재: Retry-After 동안 다음 회차 없음', requestLog.filter((r) => r.path === '/api/audit/emr').length === 0);
  await sleep(61_000);
  await shell.audit.flushQueue();
  record('현재: Retry-After 뒤 대기열 전부 전송', queueLines(pc) === 0 && rowsWhere(`AND extra->>'seq' LIKE 'cur-429-%'`).length === 5);

  // 7) 다른 기관 사용자(C)로 로그인 → 상태 확인 → 다른 기관 거부 → 게이트 닫힘(행 없음).
  tokens.current = accounts.c.token;
  await waitRegisterWindow();
  await shell.audit.tryRegister();
  const otherOrgRows = sql(`SELECT count(*) FROM devices WHERE organization_id = ${q(org2Id)};`);
  record('현재: 다른 기관 로그인 → 거부, 게이트 닫힘, 다른 기관에 행 없음', shell.audit.getEmrGate().reason === 'other_org' && otherOrgRows === '0',
    `${JSON.stringify(shell.audit.getEmrGate())}, 행 ${otherOrgRows}`);

  // 8) 원래 기관(A)으로 → 다시 열림.
  tokens.current = accounts.a.token;
  await waitRegisterWindow();
  await shell.audit.tryRegister();
  record('현재: 원래 기관으로 돌아오면 다시 열림', shell.audit.getEmrGate().allowed === true);

  // 9) 관리자 해지 → 다음 EMR 기록이 장치 문제 401 → 상태를 다시 물어(제한 간격) 게이트가 닫힘, 기록은 대기열, 거부 요약 행.
  expect200(await revoke(serverId), '관리자 해지(API)');
  await waitRegisterWindow(); // 다음 상태 확인이 제한에 걸리지 않게(설치본은 61초 간격을 스스로 지킨다)
  await shell.audit.recordAudit(entry('cur-after-revoke'), shell.audit.captureAuditContext());
  const until = Date.now() + 90_000;
  while (shell.audit.getEmrGate().reason !== 'revoked' && Date.now() < until) await sleep(500);
  const denied = sql(`SELECT count(*) FROM audit_logs WHERE action = 'emr_audit_denied' AND actor_org_id = ${q(orgId)} AND extra->>'header_device_id' = ${q(pc.meta().deviceId)};`);
  record('현재: 해지 반영 — 게이트 닫힘(해지), 기록은 대기열, 거부 요약 행', shell.audit.getEmrGate().reason === 'revoked'
    && queueLines(pc) === 1 && seqRows('cur-after-revoke').length === 0 && Number(denied) >= 1,
  `${JSON.stringify(shell.audit.getEmrGate())}, 대기열 ${queueLines(pc)}, 거부 요약 ${denied}`);

  fs.rmSync(pc.dir, { recursive: true, force: true });
}

function expect200(res, name) {
  record(name, res.status === 200, `HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// 시나리오 ③: 현재 설치본 코드 ↔ 이전 서버(7.3.1 — 서버를 되돌린 동안). --old-server [--keep-state 파일]
// 서버가 PC 단위 응답을 주지 않으므로 지금 설치본과 같은 방식(프로필 전체 상태)으로 동작해야 하고, 감사 기록은
// 거부되어 대기열에 남아야 한다(EMR은 잠기지 않는다). --keep-state로 PC 폴더와 시험 계정을 남기고, 서버를 다시
// 올린 뒤 --resume-state로 대기열이 들어가는지 확인한다.
// ---------------------------------------------------------------------------
async function oldServerScenario(pcDir) {
  const tokens = { current: accounts.a.token };
  const getAccessToken = () => tokens.current;
  const pc = pcDir ? { label: 'old', dir: pcDir, meta: () => JSON.parse(fs.readFileSync(path.join(pcDir, 'wr-device.json'), 'utf8')) } : newPc('oldserver');

  await waitRegisterWindow();
  let shell = startShell(CURRENT_DIR, pc);
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL });
  const rows = deviceRowsOfOrg();
  record('이전 서버: 첫 실행 → 승인 대기(이전 방식), pc 필드 없음', rows.length === 1 && rows[0].status === 'pending'
    && shell.audit.getEmrGate().reason === 'pending' && pc.meta().pc === undefined, JSON.stringify(shell.audit.getEmrGate()));
  const ctx = shell.audit.captureAuditContext();
  await shell.audit.recordAudit(entry('old-server-1'), ctx);
  expect200(await approve(rows[0].id), '이전 서버: 관리자 승인(API)');

  await waitRegisterWindow();
  shell = startShell(CURRENT_DIR, pc);
  await shell.audit.initAudit({ getAccessToken, apiBaseUrl: API_URL }); // 첫 토큰 확인 → active(이전 방식) → 대기열 전송 → 거부
  await sleep(2000);
  record('이전 서버: 재시작 뒤 열림(프로필 상태 active), 기록은 거부되어 대기열에 남음', shell.audit.getEmrGate().allowed === true
    && pc.meta().status === 'active' && pc.meta().pc === undefined && queueLines(pc) === 1 && seqRows('old-server-1').length === 0,
  `${JSON.stringify(shell.audit.getEmrGate())}, 대기열 ${queueLines(pc)}`);
  return { pcDir: pc.dir, eventId: ctx.eventId, occurredAt: ctx.occurredAt };
}

// --resume-state: 서버를 7.3.2로 다시 올린 뒤 — 재시작한 설치본이 PC 상태를 받고 대기열을 보낸다.
async function resumeAfterUpgrade(saved) {
  const tokens = { current: accounts.a.token };
  const pc = { label: 'old', dir: saved.pcDir, meta: () => JSON.parse(fs.readFileSync(path.join(saved.pcDir, 'wr-device.json'), 'utf8')) };
  const shell = startShell(CURRENT_DIR, pc);
  await shell.audit.initAudit({ getAccessToken: () => tokens.current, apiBaseUrl: API_URL });
  const r = seqRows('old-server-1');
  record('재업그레이드: PC 상태를 받고(active) 대기열의 기록이 시작한 사용자·시각으로 들어감', pc.meta().pc?.status === 'active'
    && queueLines(pc) === 0 && r.length === 1 && r[0].actor_user_id === accounts.a.id && r[0].extra.occurred_at === saved.occurredAt
    && r[0].extra.queued === true && r[0].extra.actor_source === 'session',
  `pc ${JSON.stringify(pc.meta().pc)}, 대기열 ${queueLines(pc)}, ${JSON.stringify(r[0]?.extra ?? null)}`);
  fs.rmSync(pc.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
let failed = false;
let keep = false;
try {
  if (saved) {
    for (const acct of Object.values(accounts)) await login(acct);
    await resumeAfterUpgrade(saved);
  } else {
    createFixtures();
    for (const acct of Object.values(accounts)) await login(acct);
    if (OLD_SERVER) {
      const state = await oldServerScenario(null);
      if (KEEP_STATE) {
        // 시험 계정의 비밀번호가 들어 있다 — 소유자만 읽고 쓰게(0600) 새로 만들고, 토큰·CSRF는 넣지 않는다(재개 때 다시 로그인).
        // 재개(--resume-state)가 끝나면 지운다. 시험 계정은 재개 실행이 지운다.
        const storedAccounts = Object.fromEntries(Object.entries(accounts).map(([k, a]) => {
          const { token: _token, csrf: _csrf, ...rest } = a;
          return [k, rest];
        }));
        // 이미 있는 파일(이전 실행의 재개 정보일 수 있다)은 덮지 않는다 — 있으면 실패하고 이번 실행의 시험 데이터를 정리한다.
        fs.writeFileSync(KEEP_STATE, JSON.stringify({ run: RUN, orgId, org2Id, accounts: storedAccounts, ...state }, null, 2), { mode: 0o600, flag: 'wx' });
        keep = true;
        console.log(`상태를 ${KEEP_STATE}에 남겼습니다(시험 계정·PC 폴더 유지) — 서버를 다시 올린 뒤 --resume-state로 이어 갑니다.`);
      }
    } else {
      if (SHELL_MODE !== 'current') await legacyScenario();
      if (SHELL_MODE !== 'legacy') await currentScenario();
    }
  }
} catch (err) {
  failed = true;
  console.error('오류:', err);
} finally {
  if (!keep || failed) {
    try {
      for (const id of [orgId, org2Id]) if (id) deleteOrg(id);
      const ids = [orgId, org2Id].filter(Boolean).map(q).join(',') || 'NULL';
      const left = sql(`SELECT count(*) FROM organizations WHERE id IN (${ids});`);
      const devicesLeft = sql(`SELECT count(*) FROM devices WHERE organization_id IN (${ids});`);
      record('정리: 시험 조직·사용자·장치 0', left === '0' && devicesLeft === '0', `조직 ${left}, 장치 ${devicesLeft}`);
      if (RESUME_STATE) fs.rmSync(RESUME_STATE, { force: true });
    } catch (err) {
      failed = true;
      console.error('정리 실패:', err);
    }
  }
}

console.log(`\n측정값: ${JSON.stringify(measured)}`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 통과`);
process.exit(failed || bad.length ? 1 : 0);
