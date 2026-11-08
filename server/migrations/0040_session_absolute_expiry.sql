-- SEC-B M3 — 세션 절대 수명. 지금까지는 refresh 회전마다 expires_at이 7일씩 밀려 세션이 끝없이 이어질 수
-- 있었다. 로그인 시각 기준 절대 만료를 두고, 회전은 이 값을 그대로 물려받는다(family_id처럼).
--
-- 쓰기 규칙(auth/sessionStore.ts):
--  - 로그인: absolute_expires_at = 로그인 시각 + SESSION_ABSOLUTE_TTL(기본 12시간).
--  - 회전: 이전 행의 absolute_expires_at을 그대로 상속. expires_at(유휴) = LEAST(지금 + REFRESH_TOKEN_TTL, 절대 만료).
--  - 확인: 인증 미들웨어·refresh·csrf 재발급·회전 모두 absolute_expires_at > now()를 요구한다.
--
-- 기존 행: 같은 계보(family_id)의 가장 이른 created_at + 12시간. 회전된 행의 created_at은 회전 시각이라
-- 행 단위로 채우면 오래 이어진 계보가 다시 12시간을 얻는다. 배포 시 12시간이 지난 계보는 바로 만료되어
-- 해당 사용자는 다시 로그인한다(7.2.0 안내서에 기재).
-- DEFAULT는 이 규칙을 모르는 쓰기(시험 픽스처 등)도 12시간 안에 묶어 두기 위한 것이다. 앱은 항상 값을 넣는다.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS absolute_expires_at TIMESTAMPTZ;

UPDATE sessions s
   SET absolute_expires_at = f.started_at + interval '12 hours'
  FROM (SELECT family_id, min(created_at) AS started_at FROM sessions GROUP BY family_id) f
 WHERE s.family_id = f.family_id
   AND s.absolute_expires_at IS NULL;

ALTER TABLE sessions ALTER COLUMN absolute_expires_at SET DEFAULT (now() + interval '12 hours');
ALTER TABLE sessions ALTER COLUMN absolute_expires_at SET NOT NULL;

COMMENT ON COLUMN sessions.absolute_expires_at IS
  '세션 계보의 절대 만료(SEC-B M3). 로그인 시각 + SESSION_ABSOLUTE_TTL, 회전 시 상속. expires_at(유휴)은 이 값을 넘지 않는다.';
