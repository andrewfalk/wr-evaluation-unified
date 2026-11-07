// 서버 테스트용 config mock 모양 (REFACTORING_ROADMAP P0-11).
// 기존 라우트 테스트 여러 파일이 같은 `vi.mock('../../config', () => ({ default: { env, cors, auth, … } }))`
// 블록을 복사해 두고 있다 — 새 테스트는 공통 모양 + 필요한 키만 덮어쓴다:
//
//   vi.mock('../../config', async () => ({
//     default: (await import('../../testing/configMock.js')).testConfig({ lockEnforcementMode: 'enforce' }),
//   }));
//
// vi.mock 팩토리는 파일 맨 위로 끌어올려지므로 바깥 import를 쓸 수 없다 — 위처럼 팩토리 안에서
// 동적 import 한다(서버 tsconfig가 Node16이라 상대 경로에 .js 확장자 필요). 이 파일은 `../config`를 **타입으로만** import하므로(런타임 import 없음) mock 대상
// 모듈을 먼저 불러오는 순환이 생기지 않는다.
//
// 결과는 실제 config의 일부만 채운 객체다. 테스트 대상 코드가 여기 없는 키를 읽으면 undefined —
// 그런 테스트는 overrides로 그 키를 채운다(키 이름 오타는 DeepPartial 타입이 잡는다).

import type { createConfig } from '../config';

export type AppConfig = ReturnType<typeof createConfig>;

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function baseTestConfig(): Record<string, unknown> {
  return {
    env:  'test',
    cors: { origins: [] },
    auth: {
      accessTokenTtl:     900,
      accessTokenSecret:  'test-access-secret-0123456789abcd',
    },
    // 'off' — 락 게이트 쿼리를 따로 준비하지 않은 테스트가 통과하도록. 락 게이팅을 검증하는 테스트는 덮어쓴다.
    lockEnforcementMode: 'off',
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/** 일반 객체는 재귀 병합, 그 밖(배열·Date·함수·원시값)은 통째로 교체. undefined 값은 키를 지우지 않고 무시. */
export function deepMerge(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) continue;
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out;
}

export function testConfig(overrides: DeepPartial<AppConfig> = {}): Record<string, unknown> {
  return deepMerge(baseTestConfig(), overrides as Record<string, unknown>);
}
