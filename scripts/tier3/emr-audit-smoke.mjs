#!/usr/bin/env node
// EMR 감사 기록 전송 경로 실서버 확인(EA-2) — 떠 있는 서버(dev 또는 패키지 스택)에 대해 설치본의 감사 코드(audit.js·
// auditQueue.js)를 Node에서 그대로 돌린다. `electron` 모듈만 가짜(app.getPath·safeStorage·net.request)로 바꾸고,
// "PC"와 "앱 재시작"마다 모듈을 새로 불러 전역 상태를 초기화한다. `npm run check`에는 넣지 않는다(서버·DB가 필요).
//
// 설치본 코드
//   legacy  scripts/tier3/fixtures/shell-7.1.4/ — 7.1.4 셸의 감사 코드 사본(커밋 77e6686의 electron/audit.js·
//           auditQueue.js·accessTokenClaims.js와 같은 내용). 시험용이며 설치본에 들어가지 않는다. 고치지 않는다.
//
// 데이터: 시험 조직 1개와 계정 3개(의사 A·B, 관리자)를 실행마다 무작위 이름·비밀번호로 DB에 만들고, 끝나면(실패해도)
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
    input: statement, encoding: 'utf8',
  }).trim();
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const rand = (n = 6) => randomBytes(n).toString('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RUN = rand(4);
const ORG_NAME = `tier3-emr-audit-${RUN}`;
const accounts = {
  a: { loginId: `t3ea-${RUN}`, name: `시험의사A-${RUN}`, role: 'doctor', password: `Pw-${rand(8)}!a` },
  b: { loginId: `t3eb-${RUN}`, name: `시험의사B-${RUN}`, role: 'doctor', password: `Pw-${rand(8)}!b` },
  admin: { loginId: `t3em-${RUN}`, name: `시험관리자-${RUN}`, role: 'admin', password: `Pw-${rand(8)}!m` },
};
let orgId = null;

function createFixtures() {
  orgId = sql(`INSERT INTO organizations (name) VALUES (${q(ORG_NAME)}) RETURNING id;`).split('\n')[0];
  for (const acct of Object.values(accounts)) {
    const hash = bcrypt.hashSync(acct.password, 10);
    acct.id = sql(`INSERT INTO users (login_id, password_hash, name, role, organization_id, must_change_password)
      VALUES (${q(acct.loginId)}, ${q(hash)}, ${q(acct.name)}, ${q(acct.role)}, ${q(orgId)}, false) RETURNING id;`).split('\n')[0];
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
    WHERE o.name ~ '^tier3-emr-audit-[0-9a-f]{8}$'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.organization_id = o.id AND u.login_id !~ '^t3e[abm]-[0-9a-f]{8}$');`).split('\n').filter(Boolean);
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
  const overlap = Math.max(20, Math.min(QUEUE_SIZE, 150));
  for (let i = 0; i < overlap; i += 1) shell.queue.enqueue(entry(`overlap-q-${i}`));
  requestLog.length = 0;
  let flushSettled = false;
  const flushing = shell.audit.flushQueue().finally(() => { flushSettled = true; });
  flushing.catch(() => {}); // 실패는 아래 await에서 받는다(처리되지 않은 거부 방지)
  const waitUntil = Date.now() + 30_000;
  while (requestLog.filter((r) => r.path === '/api/audit/emr').length < 5) {
    if (flushSettled) throw new Error('재전송 회차가 새 기록을 보내기 전에 끝났습니다(전송 실패 또는 대기열 부족)');
    if (Date.now() > waitUntil) throw new Error('재전송 회차의 응답을 30초 안에 받지 못했습니다');
    await sleep(5);
  }
  const overlapped = !flushSettled;
  await shell.audit.recordAudit(entry('overlap-live'));
  await flushing;
  record('7.1.4: 새 기록을 재전송 회차 도중에 보냄', overlapped);
  const live = seqRows('overlap-live');
  const overlapRows = rowsWhere(`AND extra->>'seq' LIKE 'overlap-q-%'`);
  record('7.1.4: 재전송 중의 새 기록이 한 건 기록됨', live.length === 1, `${live.length}건`);
  record('7.1.4: 재전송 중 대기열 전부 기록, 대기열 비움', overlapRows.length === overlap && queueLines(pc) === 0,
    `${overlapRows.length}/${overlap}, 대기열 ${queueLines(pc)}줄, 응답 ${JSON.stringify(requestLog.reduce((m, r) => ({ ...m, [r.status]: (m[r.status] ?? 0) + 1 }), {}))}`);

  fs.rmSync(pc.dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
let failed = false;
try {
  createFixtures();
  for (const acct of Object.values(accounts)) await login(acct);
  await legacyScenario();
} catch (err) {
  failed = true;
  console.error('오류:', err);
} finally {
  try {
    if (orgId) deleteOrg(orgId);
    const left = sql(`SELECT count(*) FROM organizations WHERE id = ${orgId ? q(orgId) : 'NULL'};`);
    const devicesLeft = orgId ? sql(`SELECT count(*) FROM devices WHERE organization_id = ${q(orgId)};`) : '0';
    record('정리: 시험 조직·사용자·장치 0', left === '0' && devicesLeft === '0', `조직 ${left}, 장치 ${devicesLeft}`);
  } catch (err) {
    failed = true;
    console.error('정리 실패:', err);
  }
}

console.log(`\n측정값: ${JSON.stringify(measured)}`);
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} 통과`);
process.exit(failed || bad.length ? 1 : 0);
