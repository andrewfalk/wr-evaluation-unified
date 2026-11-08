-- SEC-B L4 — 가입 요청과 조직을 잇는다. 가입 폼에는 병원 선택이 없으므로 신청은 조직 없이(NULL) 들어오고,
-- 승인·거절한 관리자의 조직을 그때 기록한다(routes/admin.ts).
--
-- 목록·승인·거절 범위: 조직 관리자는 자기 조직 행과 아직 조직이 없는(미배정) 행만 보고 처리한다.
-- 조직이 없는 관리자(슈퍼관리자)는 전체를 본다. 대기(pending) 행은 항상 미배정이므로 어느 조직 관리자든
-- 처리할 수 있고, 한 번 처리된 행은 처리한 조직만 본다.
-- 조직을 지우면 행은 남기고 미배정으로 되돌린다(ON DELETE SET NULL).
ALTER TABLE user_signup_requests
  ADD COLUMN IF NOT EXISTS organization_id UUID NULL REFERENCES organizations(id) ON DELETE SET NULL;

-- 이미 처리된 기존 행은 처리한 관리자(reviewed_by)의 조직으로 채운다. 채우지 않으면 미배정(NULL)으로
-- 남아 모든 조직 관리자에게 계속 보인다. 슈퍼관리자가 처리한 행은 지금 규칙과 같이 NULL로 남는다.
-- 다시 돌려도 결과가 같다(이미 채운 행은 건드리지 않음).
UPDATE user_signup_requests r
   SET organization_id = u.organization_id
  FROM users u
 WHERE r.reviewed_by = u.id
   AND r.status <> 'pending'
   AND r.organization_id IS NULL
   AND u.organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_signup_requests_organization_id
  ON user_signup_requests (organization_id);

COMMENT ON COLUMN user_signup_requests.organization_id IS
  '처리(승인·거절)한 관리자의 조직(SEC-B L4). 대기 중에는 NULL(미배정).';
