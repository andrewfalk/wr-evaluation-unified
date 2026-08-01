-- Electron 로그인은 리프레시 쿠키를 세션 쿠키로 발급해 앱 종료 시 재로그인을 강제한다.
-- 웹은 기존처럼 영구 쿠키(DEFAULT true)를 유지한다.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS persistent_cookie BOOLEAN NOT NULL DEFAULT true;
