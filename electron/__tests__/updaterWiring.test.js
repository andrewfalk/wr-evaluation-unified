import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// main.js는 단위 테스트가 어려운 구조(Electron 모듈 직접 사용)라, 업데이트 서명 검증(HF8)을 **우회하는 후퇴**를 소스 수준에서 막는다.
// 가장 위험한 후퇴는 autoDownload를 다시 켜는 것이다 — 켜면 update-available 직후 검증 없이 설치본을 내려받는다.
// 게이트 자체의 동작은 updateFeedVerify.test.js의 createDownloadGate 테스트가 가짜 객체로 검증한다.
const MAIN = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js'), 'utf8');

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
    const gate = MAIN.match(/createDownloadGate\(\{[\s\S]*?\n  \}\);/)?.[0] ?? '';
    expect(gate).toMatch(/feedBaseUrl:\s*feed\.url/);
    expect(gate).toMatch(/channel:\s*WR_UPDATE_CHANNEL/);
    expect(gate).toMatch(/publicKeys:\s*UPDATE_SIGNING_PUBLIC_KEYS/);
  });

  it('update-available 핸들러가 게이트를 부른다', () => {
    const handler = MAIN.match(/autoUpdater\.on\('update-available'[\s\S]*?\n  \}\);/)?.[0] ?? '';
    expect(handler).toContain('downloadGate(info)');
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
});
