-- SEC-B M2 — 계정별 로그인 실패 backoff/잠금. IP 기준 limiter(분당 5회)는 그대로 두고, 같은 로그인 ID에
-- 대한 실패를 DB에 세어 여러 IP·여러 서버 프로세스에서 나눠 시도해도 함께 잠기게 한다.
--
-- 키(login_hash) = sha256(정규화한 로그인 ID) 16진수. 정규화 = NFC → 앞뒤 공백 제거 → 소문자.
-- 존재하지 않는 ID도 같은 경로로 행을 만든다(잠금 여부로 계정 존재를 알 수 없게). 평문 ID는 저장하지 않는다.
--
-- 쓰기 규칙(auth/loginBackoff.ts):
--  - 실패: INSERT … ON CONFLICT DO UPDATE 한 문장으로 failures + 1, 5회째부터 locked_until 설정
--    (1분, 이후 실패마다 2배, 상한 15분). 동시 실패는 행 잠금으로 직렬화되어 하나도 빠지지 않는다.
--    마지막 실패가 24시간 전이면 failures를 1부터 다시 센다.
--  - 잠금 중 요청은 비밀번호를 확인하지 않고 429 LOGIN_LOCKED로 거부하며 failures를 늘리지 않는다.
--  - 성공: 행 삭제.
-- 정리: 24시간 넘게 갱신되지 않았고 잠겨 있지 않은 행은 jobs/loginBackoff.ts 정리 작업이 지운다.
CREATE TABLE IF NOT EXISTS login_backoff (
  login_hash   TEXT        PRIMARY KEY,
  failures     INTEGER     NOT NULL CHECK (failures > 0),
  locked_until TIMESTAMPTZ NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS login_backoff_updated_at_idx ON login_backoff (updated_at);

COMMENT ON TABLE login_backoff IS
  '로그인 ID별 실패 횟수·잠금(SEC-B M2). 키는 정규화한 로그인 ID의 sha256, 성공 시 삭제, 24시간 뒤 정리.';
