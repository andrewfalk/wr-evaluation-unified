// 기본 인트라넷 주소 일치(P2-87, Phase 2 C9 구간 A) — 설정 창의 기본 주소 상수가 Electron 셸(main·인트라넷 preload)의
// 기본 주소와 같은 값인지 본다. preload는 sandbox라 로컬 모듈을 불러올 수 없어 상수 하나로 묶을 수 없으므로, 셸 두 파일의
// `const DEFAULT_INTRANET_URL = '…';` 한 줄을 파일에서 읽어 비교한다(공개 저장소 — 값은 이 테스트에 적지 않는다).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_INTRANET_URL } from '../connectionStatus';

const SHELL_FILES = ['electron/main.js', 'electron/preload-intranet.js'];

function readShellDefault(file: string): string {
  const source = readFileSync(file, 'utf8');
  const matches = [...source.matchAll(/^const DEFAULT_INTRANET_URL = '([^']*)';$/gm)];
  if (matches.length !== 1) throw new Error(`${file}: 기본 주소 선언이 ${matches.length}개(한 줄이어야 한다)`);
  return matches[0][1];
}

describe('기본 인트라넷 주소 — 설정 창과 Electron 셸이 같다', () => {
  it.each(SHELL_FILES)('%s의 기본 주소와 설정 창의 기본 주소가 같다', (file) => {
    const shellDefault = readShellDefault(file);
    expect(shellDefault.length).toBeGreaterThan(0);
    // 값을 실패 메시지에 그대로 내지 않으려고 같음만 본다.
    expect(DEFAULT_INTRANET_URL === shellDefault, `${file}의 기본 주소와 다르다`).toBe(true);
  });

  it('셸 두 파일의 기본 주소도 서로 같다', () => {
    const [main, preload] = SHELL_FILES.map(readShellDefault);
    expect(main === preload, 'electron/main.js와 electron/preload-intranet.js의 기본 주소가 다르다').toBe(true);
  });
});
