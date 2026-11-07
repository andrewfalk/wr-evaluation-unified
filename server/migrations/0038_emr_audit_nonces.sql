-- SEC-A L11 — EMR 감사(POST /api/audit/emr) 서명 요청의 nonce를 메모리가 아니라 DB에 기록한다.
-- 이전에는 프로세스 메모리(Map/Set)에만 있어 서버를 재시작하면 같은 서명 요청을 다시 받을 수 있었다.
--
-- 쓰기 규칙(routes/audit.ts): 서명·장치 검증을 통과한 뒤 한 트랜잭션에서
--   INSERT … ON CONFLICT DO NOTHING RETURNING 1  →  감사 행 INSERT  →  COMMIT.
--  - 이미 있는 (device_id, nonce)면 0행 → ROLLBACK, 기존 응답 그대로 401 UNAUTHORIZED.
--  - 감사 INSERT가 실패하면 ROLLBACK으로 nonce 행도 사라져 장치가 같은 요청을 다시 보낼 수 있다.
--  - 같은 nonce의 동시 요청은 PK 행 잠금으로 직렬화되어 두 번째가 0행을 받는다.
-- 보존: 서명 타임스탬프 허용 범위(±5분)를 넘는 요청은 nonce 확인 전에 거부되므로, 24시간 지난 행은
-- jobs/emrAuditNonces.ts 정리 작업이 지운다.
CREATE TABLE IF NOT EXISTS emr_audit_nonces (
  device_id UUID        NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  nonce     TEXT        NOT NULL,
  seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (device_id, nonce)
);

CREATE INDEX IF NOT EXISTS emr_audit_nonces_seen_at_idx ON emr_audit_nonces (seen_at);

COMMENT ON TABLE emr_audit_nonces IS
  'EMR 감사 서명 요청 nonce(재전송 차단). 감사 행과 같은 트랜잭션에서 기록, 24시간 뒤 정리.';
