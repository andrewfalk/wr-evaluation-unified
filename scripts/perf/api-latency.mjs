// P0-13 성능 기준선 ② — 주요 API의 클라이언트 측 응답 시간 p50/p95.
//
// 시험 스택(verify-stack.ps1, 일회용 DB)에 로그인해 시나리오를 --iterations번 반복 호출한다. **운영 서버에
// 돌리지 않는다** — 환자 수정·워크스페이스 저장·통계 분석이 실제로 기록을 만든다.
// 로그인 정보는 명령 인자가 아니라 환경변수로만 받는다(셸 기록·프로세스 목록에 남지 않게):
//   WR_PERF_LOGIN_ID, WR_PERF_PASSWORD   — seed-admin 으로 만든 시험 계정
//
//   node scripts/perf/api-latency.mjs [--base https://wr.hospital.local:8443] [--iterations 30] [--json out.json]
//
// --base 기본은 Caddy 경유 8443(실사용 경로). Node는 Windows 인증서 저장소를 쓰지 않으므로 내부 CA를
// NODE_EXTRA_CA_CERTS 로 알려 준다(시험 스택 CA: release\.verify-stack 의 루트 인증서 또는 caddy 볼륨에서 꺼낸 것).
// 앱만 재려면 --base http://127.0.0.1:13001(앱 루프백 게시, Caddy 제외 — 이때 쿠키 Secure 때문에 CSRF 쿠키를
// 응답 헤더에서 직접 읽는다).
//
// 시나리오(한 반복):
//   patients.list   GET  /api/patients?limit=50
//   patients.get    GET  /api/patients/:id             (목록 첫 환자)
//   patients.patch  PATCH /api/patients/:id            (같은 data 그대로, If-Match: revision)
//   workspaces.list GET  /api/workspaces
//   workspaces.save PUT  /api/workspaces/:id           (첫 반복만 POST로 만든 뒤 덮어쓰기, 환자 20명 — 끝나면 삭제)
//   stats.catalog   GET  /api/stats/catalog
//   stats.preview   POST /api/stats/preview            (기술통계 recipe, 변수 1개)
//   stats.analyze   POST /api/stats/analyze            (같은 recipe — 두 번째부터는 DB 캐시 적중 경로)
// 분석 요청은 서버 제한(분당 20회)에 맞춰 반복 사이 간격을 둔다(--analyze-interval-ms, 기본 3100).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { markdownTable, parseArgs, percentile, round } from './lib/perfLib.mjs';

/** Set-Cookie 헤더들에서 이름이 같은 쿠키 값. */
export function readCookie(setCookieHeaders, name) {
  for (const header of setCookieHeaders ?? []) {
    const first = header.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0 && first.slice(0, eq).trim() === name) return decodeURIComponent(first.slice(eq + 1).trim());
  }
  return null;
}

/** GET /api/patients/:id 응답의 revision(sync.revision, 예전 모양이면 최상위 revision). */
export function patientRevision(patient) {
  const rev = patient?.sync?.revision ?? patient?.revision;
  return Number.isInteger(rev) ? rev : null;
}

/** 워크스페이스 저장 응답({ items: [...] } — 갱신된 목록)에서 이름이 같은 항목의 id. */
export function findWorkspaceId(saveResponse, name) {
  const items = Array.isArray(saveResponse?.items) ? saveResponse.items : [];
  return items.find(item => item?.name === name)?.id ?? null;
}

export function summarizeSamples(samplesByStep) {
  return Object.entries(samplesByStep).map(([step, list]) => {
    const ok = list.filter(s => s.ok).map(s => s.ms);
    return {
      step,
      count: list.length,
      errors: list.length - ok.length,
      p50: round(percentile(ok, 50)),
      p95: round(percentile(ok, 95)),
      max: ok.length ? round(Math.max(...ok)) : null,
    };
  });
}

const DESCRIPTIVE_RECIPE = {
  grain: 'case', filters: [], analysisPurpose: 'association', formulaPolicies: {},
  variableKeys: ['knee.relatedness.max'], analysisMode: 'descriptive',
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const base = String(args.base ?? 'https://wr.hospital.local:8443').replace(/\/$/, '');
  const iterations = Number(args.iterations ?? 30);
  const analyzeIntervalMs = Number(args['analyze-interval-ms'] ?? 3100);
  const loginId = process.env.WR_PERF_LOGIN_ID;
  const password = process.env.WR_PERF_PASSWORD;
  if (!loginId || !password) {
    console.error('api-latency: WR_PERF_LOGIN_ID / WR_PERF_PASSWORD 환경변수가 필요합니다(시험 스택 계정).');
    process.exit(2);
  }

  const loginRes = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginId, password, rememberMe: false }),
  });
  if (!loginRes.ok) {
    console.error(`api-latency: 로그인 실패 HTTP ${loginRes.status}`);
    process.exit(1);
  }
  const { accessToken, user } = await loginRes.json();
  if (user?.mustChangePassword) {
    console.error('api-latency: 이 계정은 비밀번호 변경이 필요합니다 — 앱에서 한 번 바꾼 뒤 다시 실행하세요.');
    process.exit(1);
  }
  const csrf = readCookie(loginRes.headers.getSetCookie(), 'wr_csrf');
  if (!csrf) { console.error('api-latency: 로그인 응답에 CSRF 쿠키가 없습니다'); process.exit(1); }
  const headers = { Authorization: `Bearer ${accessToken}`, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' };

  const samples = {};
  async function timed(step, method, urlPath, { body, extraHeaders } = {}) {
    const t0 = performance.now();
    let res;
    let json = null;
    try {
      res = await fetch(`${base}${urlPath}`, { method, headers: { ...headers, ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    } catch (err) {
      (samples[step] ??= []).push({ ms: performance.now() - t0, ok: false });
      console.error(`  ${step}: 요청 실패 ${err.message}`);
      return null;
    }
    const ms = performance.now() - t0;
    const ok = res.ok;
    (samples[step] ??= []).push({ ms, ok });
    if (!ok) console.error(`  ${step}: HTTP ${res.status} ${json?.code ?? ''}`);
    return ok ? json : null;
  }

  const golden = JSON.parse(fs.readFileSync(path.resolve('src/core/fixtures/goldenPatients.json'), 'utf8'));
  const workspacePatients = golden.slice(0, 20);
  let workspaceId = null;
  const workspaceName = `perf-baseline-${Date.now()}`;
  let lastAnalyzeAt = 0;

  for (let i = 0; i < iterations; i += 1) {
    const list = await timed('patients.list', 'GET', '/api/patients?limit=50');
    const first = list?.patients?.[0] ?? list?.items?.[0];
    if (first?.id) {
      const full = await timed('patients.get', 'GET', `/api/patients/${first.id}`);
      const revision = patientRevision(full);
      if (revision !== null && full?.data) {
        await timed('patients.patch', 'PATCH', `/api/patients/${first.id}`, {
          body: { data: { shared: full.data.shared, modules: full.data.modules, activeModules: full.data.activeModules } },
          extraHeaders: { 'If-Match': String(revision) },
        });
      } else if (i === 0) {
        console.error('  patients.patch: 환자 응답에 revision/data가 없어 건너뜀');
      }
    }
    await timed('workspaces.list', 'GET', '/api/workspaces');
    if (workspaceId === null) {
      const created = await timed('workspaces.create', 'POST', '/api/workspaces', { body: { name: workspaceName, patients: workspacePatients } });
      workspaceId = findWorkspaceId(created, workspaceName);
      if (workspaceId === null) { console.error('  workspaces.create: 응답 목록에서 새 워크스페이스를 찾지 못함 — 중단'); process.exit(1); }
    } else {
      await timed('workspaces.save', 'PUT', `/api/workspaces/${workspaceId}`, { body: { name: workspaceName, patients: workspacePatients } });
    }
    await timed('stats.catalog', 'GET', '/api/stats/catalog');
    await timed('stats.preview', 'POST', '/api/stats/preview', { body: DESCRIPTIVE_RECIPE });
    const wait = lastAnalyzeAt + analyzeIntervalMs - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastAnalyzeAt = Date.now();
    await timed(i === 0 ? 'stats.analyze(first)' : 'stats.analyze(cached)', 'POST', '/api/stats/analyze', { body: DESCRIPTIVE_RECIPE });
    process.stderr.write(`\r  반복 ${i + 1}/${iterations}`);
  }
  process.stderr.write('\n');

  if (workspaceId !== null) {
    const del = await fetch(`${base}/api/workspaces/${workspaceId}`, { method: 'DELETE', headers });
    if (!del.ok) console.error(`  시험 워크스페이스 삭제 실패 HTTP ${del.status} (id ${workspaceId})`);
  }
  const rows = summarizeSamples(samples);
  console.log(`대상 ${base.startsWith('https://') ? 'Caddy 경유(HTTPS)' : '앱 직접'} · 반복 ${iterations}회`);
  console.log(markdownTable(['단계', '건수', '오류', 'p50 ms', 'p95 ms', '최대 ms'], rows.map(r => [r.step, r.count, r.errors, r.p50, r.p95, r.max])));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, `${JSON.stringify({ base: base.startsWith('https://') ? 'caddy' : 'app', iterations, rows }, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
