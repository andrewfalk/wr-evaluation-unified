import { describe, expect, it } from 'vitest';
import { isPermissionAllowed, ALLOWED_PERMISSIONS } from '../permissionPolicy.js';

describe('isPermissionAllowed (HF9)', () => {
  it('관리자 콘솔의 임시 비밀번호 복사에 쓰는 클립보드 쓰기만 허용한다', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write')).toBe(true);
    expect([...ALLOWED_PERMISSIONS]).toEqual(['clipboard-sanitized-write']);
  });

  it.each([
    'media', 'geolocation', 'notifications', 'midi', 'midiSysex', 'pointerLock', 'fullscreen',
    'openExternal', 'clipboard-read', 'display-capture', 'idle-detection', 'window-placement',
    'mediaKeySystem', 'unknown-future-permission', '', undefined, null,
  ])('그 밖의 권한은 모두 거부 — %s', (permission) => {
    expect(isPermissionAllowed(permission)).toBe(false);
  });
});
