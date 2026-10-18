'use strict';

// 업데이트 피드 서명 검증용 공개 키 목록(Ed25519, SPKI PEM). 이 키에 대응하는 비밀 키는 릴리스 PC에만 있고
// 이 저장소에 두지 않는다(scripts/sign-update-feed.mjs --generate-keypair 가 저장소 밖에만 만든다).
//
// 셸은 목록의 어느 키로든 서명이 맞으면 업데이트를 받는다. 키를 바꿀 때는 새 공개 키를 추가한 셸을 먼저 배포하고,
// 모든 PC가 그 셸이 된 뒤에 옛 키를 뺀다(그 전에 옛 키를 빼면 아직 옛 셸인 PC가 새 서명을 못 믿는다).
// 비어 있으면 셸은 모든 업데이트를 거부하고(fail-closed), 패키징 사전 검증이 서명을 확인하지 못해 중단된다.
//
// 공개 키는 비밀이 아니다 — 커밋해도 안전하다. 이 목록은 신뢰의 뿌리이므로 바꾸는 변경은 반드시 리뷰에서 지문을
// 확인한다(electron/__tests__/updateSigningPublicKey.test.js가 지문을 고정해 두어 의도하지 않은 변경이 테스트로 드러난다).
const UPDATE_SIGNING_PUBLIC_KEYS = [
  // 2026-10-18 등록. SHA-256(SPKI DER) = f87a108f5a2488c5b85563fe578555248ee05898707e58875fdfe7f0511a69f6
  [
    '-----BEGIN PUBLIC KEY-----',
    'MCowBQYDK2VwAyEAJDPNaS+USOzhWi3LW9kr1Ir7Jzdxd1+pfcJ0YTABmgs=',
    '-----END PUBLIC KEY-----',
    '',
  ].join('\n'),
];

module.exports = { UPDATE_SIGNING_PUBLIC_KEYS };
