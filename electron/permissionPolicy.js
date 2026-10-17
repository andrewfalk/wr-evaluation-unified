'use strict';
// electron/permissionPolicy.js — HF9(L9)
// Electron은 세션 권한(카메라·알림·위치·클립보드 읽기 등)을 기본적으로 "전부 허용"한다. 앱이 실제로 쓰는 것만
// 허용하고 나머지는 거부한다. electron에 의존하지 않는 순수 모듈이라 테스트한다.
//
// 허용 목록(이유가 있는 것만 추가할 것):
//  - clipboard-sanitized-write: AdminConsoleModal이 임시 비밀번호를 navigator.clipboard.writeText로 복사한다
//    (쓰기 전용 — 클립보드 읽기 'clipboard-read'는 허용하지 않는다).
const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

function isPermissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

module.exports = { isPermissionAllowed, ALLOWED_PERMISSIONS };
