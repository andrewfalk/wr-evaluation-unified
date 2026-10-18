import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { createDownloadGate } from '../updateFeedVerify.js';
import { decideUpdatePhaseTransition } from '../updateFeed.js';

// main.js는 단위 테스트가 어려운 구조(Electron 모듈 직접 사용)라, 업데이트 서명 검증(HF8)을 **우회하는 후퇴**를 소스 수준에서 막는다.
// 가장 위험한 후퇴는 autoDownload를 다시 켜는 것이다 — 켜면 update-available 직후 검증 없이 설치본을 내려받는다.
// 게이트 자체의 동작은 updateFeedVerify.test.js의 createDownloadGate 테스트가 가짜 객체로 검증한다.
const MAIN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');

const handlerSource = (event) => MAIN.match(new RegExp(`autoUpdater\\.on\\('${event}'[\\s\\S]*?\\n {2}\\}\\);`))?.[0] ?? '';

describe('main.js 업데이트 연결(HF8)', () => {
  it('autoDownload를 끈다 — 켜면 서명 검증 없이 내려받는다', () => {
    expect(MAIN).toMatch(/autoUpdater\.autoDownload\s*=\s*false\s*;/);
    expect(MAIN).not.toMatch(/autoDownload\s*=\s*true/);
  });

  it('downloadUpdate()를 부르는 곳은 서명 게이트의 download 콜백 하나뿐이다', () => {
    const calls = MAIN.match(/autoUpdater\.downloadUpdate\s*\(/g) ?? [];
    expect(calls).toHaveLength(1);
    expect(MAIN).toMatch(/download:\s*\(\)\s*=>\s*\{\s*autoUpdater\.downloadUpdate\(\)/);
  });

  it('게이트는 내장 공개 키 목록·현재 채널·electron-updater와 같은 피드 주소로 만든다', () => {
    const gate = MAIN.match(/createDownloadGate\(\{[\s\S]*?\n {2}\}\);/)?.[0] ?? '';
    expect(gate).toMatch(/feedBaseUrl:\s*feed\.url/);
    expect(gate).toMatch(/channel:\s*WR_UPDATE_CHANNEL/);
    expect(gate).toMatch(/publicKeys:\s*UPDATE_SIGNING_PUBLIC_KEYS/);
  });

  it('update-available 핸들러가 게이트를 부른다', () => {
    expect(handlerSource('update-available')).toContain('downloadGate(info)');
  });

  it('게이트의 예외까지 업데이트 실패로 집계해 unhandled rejection이 되지 않게 한다', () => {
    expect(MAIN).toMatch(/downloadGate\(info\)\.catch\(\(err\) => handleUpdaterFailure\(err\)\)/);
  });

  it('서명 검증 거부는 전용 라벨로 집계한다', () => {
    expect(MAIN).toMatch(/onRejected:\s*\(err\) => handleUpdaterFailure\(err,\s*'업데이트 서명 검증 실패'\)/);
  });

  it('검증 모듈과 공개 키 목록을 불러온다', () => {
    expect(MAIN).toMatch(/require\('\.\/updateFeedVerify'\)/);
    expect(MAIN).toMatch(/require\('\.\/updateSigningPublicKey'\)/);
  });

  it('서명 파일을 받는 요청은 정책 조회와 같은 GET 헬퍼를 쓰고 캐시 버스터를 붙인다', () => {
    expect(MAIN).toMatch(/fetchBuffer:\s*\(url, maxBytes\) => httpGetBuffer\(`\$\{url\}\?t=\$\{Date\.now\(\)\}`, maxBytes\)/);
  });

  // 재시도 간격(첫 실패 15분 → 이후 1시간)이 서명 거부에도 작동하려면 연속 실패 횟수를 "검증 통과 후"에만 지워야 한다.
  it('update-available 핸들러는 연속 실패 횟수를 지우지 않는다 — 그 이벤트는 서명 검증 통과가 아니다', () => {
    expect(handlerSource('update-available')).not.toContain('clearUpdaterFailureStatus');
  });

  it('연속 실패 횟수는 게이트의 onVerified(검증 통과 시점)에서 지운다', () => {
    expect(MAIN).toMatch(/onVerified:\s*clearUpdaterFailureStatus/);
  });

  it('update-not-available(확인 성공 + 업데이트 없음)에서는 계속 지운다', () => {
    expect(handlerSource('update-not-available')).toContain('clearUpdaterFailureStatus()');
  });
});

// ---------------------------------------------------------------------------
// main.js의 "실제 코드"를 잘라 가짜 의존성과 함께 실행한다. 재시도 간격은 handleUpdaterFailure·clearUpdaterFailureStatus·
// update-available 핸들러·게이트 연결 세 조각의 순서가 엮인 동작이라 소스 단언만으로는 못 지킨다(리뷰 P2에서 실제로 놓쳤다).
// main.js 구조가 바뀌어 추출이 안 되면 조용히 통과하지 않고 이유를 알려 주며 실패한다 — 그때 이 추출 규칙을 갱신한다.
// ---------------------------------------------------------------------------
function balancedEnd(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') { depth -= 1; if (depth === 0) return i + 1; }
  }
  throw new Error('중괄호 짝을 찾지 못했습니다');
}

function functionSource(name) {
  const start = MAIN.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`main.js에서 ${name}을(를) 찾지 못했습니다 — 시뮬레이션 추출 규칙을 갱신하세요`);
  return MAIN.slice(start, balancedEnd(MAIN, MAIN.indexOf('{', MAIN.indexOf(')', start))));
}

function wiringSource() {
  const start = MAIN.indexOf('const downloadGate = createDownloadGate({');
  const handlerAt = MAIN.indexOf("autoUpdater.on('update-available'");
  if (start < 0 || handlerAt < start) throw new Error('main.js에서 게이트·update-available 연결을 찾지 못했습니다 — 시뮬레이션 추출 규칙을 갱신하세요');
  return MAIN.slice(start, MAIN.indexOf('\n  });', handlerAt) + '\n  });'.length);
}

const signer = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const ymlBytes = Buffer.from(yaml.dump({ version: '7.1.5', files: [{ url: 'x.exe', sha512: 'aGk=', size: 1 }], path: 'x.exe', sha512: 'aGk=' }));
const sigBytes = Buffer.from(`${crypto.sign(null, ymlBytes, crypto.createPrivateKey(signer.privateKey)).toString('base64')}\n`);
const feedInfo = yaml.load(ymlBytes.toString('utf8'));

// steps: 'no-sig'(서명 파일 누락) | 'good'(정상 서명). 각 단계에서 update-available를 한 번 받은 것처럼 실행한다.
async function simulate(steps) {
  const ctx = { scheduled: [], labels: [], handlers: {}, downloads: 0, mode: 'no-sig' };
  ctx.autoUpdater = { on: (event, fn) => { ctx.handlers[event] = fn; }, downloadUpdate: () => { ctx.downloads += 1; return Promise.resolve(); } };
  ctx.httpGetBuffer = async (url) => (ctx.mode === 'good' ? (url.includes('.sig') ? sigBytes : ymlBytes) : (url.includes('.sig') ? null : ymlBytes));
  ctx.createDownloadGate = createDownloadGate;
  ctx.decideUpdatePhaseTransition = decideUpdatePhaseTransition;
  ctx.keys = [signer.publicKey];

  new Function('ctx', `
    let updatePhase = 'idle', consecutiveFailures = 0, checkTimer = null;
    const PHASE_LABEL = { checking: '업데이트 확인 실패', downloading: '업데이트 다운로드 실패', installing: '업데이트 설치 실패' };
    const { decideUpdatePhaseTransition, createDownloadGate } = ctx;
    function applyUpdatePhaseTransition(event) { const r = decideUpdatePhaseTransition(event); updatePhase = r.phase; return r.phase; }
    function scheduleNextCheck(ms) { ctx.scheduled.push(ms / 60000); }
    function logUpdateEvent() {}
    function setUpdateMenuStatusLabel(text) { ctx.labels.push(text); }
    ${functionSource('handleUpdaterFailure')}
    ${functionSource('clearUpdaterFailureStatus')}
    const feed = { url: 'https://wr.example/updates' };
    const WR_UPDATE_CHANNEL = 'latest';
    const UPDATE_SIGNING_PUBLIC_KEYS = ctx.keys;
    const httpGetBuffer = ctx.httpGetBuffer;
    const autoUpdater = ctx.autoUpdater;
    ${wiringSource()}
    ctx.failures = () => consecutiveFailures;
  `)(ctx);

  const rows = [];
  for (const step of steps) {
    ctx.mode = step;
    ctx.handlers['update-available'](feedInfo);
    await new Promise((resolve) => setTimeout(resolve, 20));
    rows.push({
      step,
      failures: ctx.failures(),
      nextCheckMinutes: ctx.scheduled[ctx.scheduled.length - 1] ?? null,
      downloads: ctx.downloads,
      label: ctx.labels[ctx.labels.length - 1],
    });
  }
  return rows;
}

describe('main.js의 실제 업데이트 코드로 시뮬레이션 — 서명 검증 거부가 이어질 때의 재시도', () => {
  it('서명 파일 누락이 연속되면 실패 횟수가 쌓이고 재시도 간격이 첫 실패 15분 → 이후 1시간으로 늘어난다', async () => {
    const rows = await simulate(['no-sig', 'no-sig', 'no-sig']);
    expect(rows.map((r) => r.failures)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.nextCheckMinutes)).toEqual([15, 60, 60]);
    expect(rows.map((r) => r.label)).toEqual(['업데이트 서명 검증 실패 (1회)', '업데이트 서명 검증 실패 (2회)', '업데이트 서명 검증 실패 (3회)']);
  });

  it('거부되는 동안에는 다운로드를 시작하지 않는다', async () => {
    const rows = await simulate(['no-sig', 'no-sig']);
    expect(rows.every((r) => r.downloads === 0)).toBe(true);
  });

  it('검증을 통과하면 실패 횟수와 메뉴 라벨이 초기화되고 다운로드가 시작된다', async () => {
    const rows = await simulate(['no-sig', 'no-sig', 'good']);
    expect(rows[2]).toMatchObject({ step: 'good', failures: 0, downloads: 1, label: '' });
  });

  it('성공으로 초기화된 뒤의 거부는 다시 1회·15분부터 센다', async () => {
    const rows = await simulate(['no-sig', 'no-sig', 'good', 'no-sig']);
    expect(rows[3]).toMatchObject({ failures: 1, nextCheckMinutes: 15, downloads: 1, label: '업데이트 서명 검증 실패 (1회)' });
  });
});
