# 7.1.4 설치본 감사 코드 사본(시험용)

`audit.js`·`auditQueue.js`·`accessTokenClaims.js`는 릴리스 7.1.4 커밋 `77e6686`의 `electron/` 파일과 내용이 같다.
`scripts/tier3/emr-audit-smoke.mjs`가 이 사본을 가짜 `electron` 모듈(`scripts/lib/fakeElectron.cjs`)로 불러
현재 서버가 이전 설치본의 감사 기록을 받는지 확인한다.

- 설치본에 들어가지 않는다(`electron/` 밖). 고치지 않는다 — `scripts/tier3Fixtures.test.mjs`가 git 블롭 해시로 확인한다.
