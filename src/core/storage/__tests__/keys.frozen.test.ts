// 저장소 키 리터럴 고정(REFACTORING_ROADMAP Phase 2 P2-18). 값은 저장된 데이터·탭 간 프로토콜의 일부라 **바꾸면 안 된다**
// (구·신 번들 탭이 섞인 동안 다른 이름은 서로를 보지 못한다). 이 테스트가 실패하면 키를 되돌린다 — 기대값을 고치지 않는다.
import { describe, expect, it } from 'vitest';
import { AUTH_PROTOCOL, STORAGE_KEYS } from '../keys';

describe('storage keys (frozen)', () => {
  it('데이터 키 8종', () => {
    expect(STORAGE_KEYS).toEqual({
      savedItems: 'wrEvalUnifiedSavedItems',
      autoSave: 'wrEvalUnifiedAutoSave',
      settings: 'wrEvalUnifiedSettings',
      deviceId: 'wrEvalUnifiedDeviceId',
      authSession: 'wrEvalUnifiedAuthSession',
      customPresets: 'wrEvalUnifiedCustomPresets',
      lockClientInstanceId: 'wrEvalUnified.lockClientInstanceId',
      legacySavedItems: 'wrEvaluationSavedItems',
    });
  });

  it('탭 간 인증 프로토콜 상수 4종', () => {
    expect(AUTH_PROTOCOL).toEqual({
      refreshLockName: 'wr-auth-refresh',
      refreshLockKey: 'wr-auth-refresh-lock',
      refreshSignalKey: 'wr-auth-refresh-sig',
      channelName: 'wr-auth',
    });
  });

  it('값이 서로 겹치지 않는다', () => {
    const values = [...Object.values(STORAGE_KEYS), ...Object.values(AUTH_PROTOCOL)];
    expect(new Set(values).size).toBe(values.length);
  });
});
