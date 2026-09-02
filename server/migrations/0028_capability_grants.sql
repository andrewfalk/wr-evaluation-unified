-- 통계 워크벤치 권한 체계(PR0-A). `researcher` 역할을 추가하는 대신 사용자별 권한
-- 부여 테이블을 둔다 — 개별 의사가 연구를 겸하는 경우를 역할로는 표현할 수 없기 때문.
--
-- capabilities: 허용 키를 FK로 고정해 오타나 임의 문자열이 권한이 되지 않게 하는
-- 참조 테이블. default_all_roles=true인 키는 grant 없이도 모든 사용자가 통과한다
-- (requireCapability의 판정 기준). requires_step_up/requires_admin_role은 정보성
-- 플래그일 뿐 여기서 강제하지 않는다 — 실제 강제는 라우트에서 미들웨어 조합으로 한다
-- (stats.export_phi의 admin+grant+step-up 조합은 PR5-B에서 조립).
CREATE TABLE capabilities (
  key                 TEXT PRIMARY KEY,
  label               TEXT NOT NULL,
  description         TEXT,
  default_all_roles   BOOLEAN NOT NULL DEFAULT false,
  requires_step_up    BOOLEAN NOT NULL DEFAULT false,
  requires_admin_role BOOLEAN NOT NULL DEFAULT false,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO capabilities (key, label, description, default_all_roles, requires_step_up, requires_admin_role) VALUES
  ('stats.view',                '통계 화면 열람',              '카탈로그·레시피·결과 화면 열람',                      true,  false, false),
  ('stats.regression',          '회귀 분석 실행',              '이변량·회귀·예측 분석 실행',                          true,  false, false),
  ('stats.export_results',      '집계 결과 내보내기',           '저장된 집계표·회귀 결과 export',                      true,  false, false),
  ('stats.export_limited_rows', '행 단위 제한데이터 내보내기',   '직접식별자 제거 행 단위 export, step-up 불필요',       false, false, false),
  ('stats.export_phi',          'PHI 포함 원자료 내보내기',      'admin 역할 + 활성 grant + step-up + 사유 모두 필요',   false, true,  true);

-- 복합 FK를 걸 수 있도록 부모(users)에 대상 키를 만든다. users 테이블(조직당 수십~수백
-- 행 규모)에 유니크 인덱스를 하나 더 추가하는 작업이라 짧은 락이 발생할 수 있으나
-- 인트라넷 배포 규모에서는 순간적이며 다운타임이 필요하지 않다.
ALTER TABLE users ADD CONSTRAINT users_id_org_uniq UNIQUE (id, organization_id);

CREATE TABLE user_capability_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE RESTRICT,
  capability      TEXT NOT NULL REFERENCES capabilities(key) ON DELETE RESTRICT,
  granted_by      UUID,
  granted_by_org  UUID,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ,
  reason          TEXT NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_by      UUID,
  revoked_by_org  UUID,
  revocation_reason TEXT
    CHECK (revocation_reason IN ('expired_regrant','manual','self_revoke','role_change')),

  -- 수여자·회수자·피수여자가 모두 같은 조직임을 DB가 보장한다.
  CONSTRAINT grant_user_in_org    FOREIGN KEY (user_id, organization_id)
    REFERENCES users(id, organization_id) ON DELETE CASCADE,
  CONSTRAINT grant_granter_in_org FOREIGN KEY (granted_by, granted_by_org)
    REFERENCES users(id, organization_id) ON DELETE SET NULL,
  CONSTRAINT grant_revoker_in_org FOREIGN KEY (revoked_by, revoked_by_org)
    REFERENCES users(id, organization_id) ON DELETE SET NULL,
  CONSTRAINT grant_granter_org    CHECK (granted_by_org IS NULL OR granted_by_org = organization_id),
  CONSTRAINT grant_revoker_org    CHECK (revoked_by_org IS NULL OR revoked_by_org = organization_id),
  CONSTRAINT grant_granter_paired CHECK ((granted_by IS NULL) = (granted_by_org IS NULL)),
  CONSTRAINT grant_revoker_paired CHECK ((revoked_by IS NULL) = (revoked_by_org IS NULL)),
  CONSTRAINT grant_ttl            CHECK (expires_at IS NULL OR expires_at > granted_at),
  CONSTRAINT grant_revoke_order   CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
  -- 회수 시각과 사유는 함께 있거나 함께 없다. 시스템이 닫은 경우 revoked_by는 NULL이지만
  -- revocation_reason은 반드시 남는다('expired_regrant').
  CONSTRAINT grant_revocation_state CHECK (
    (revoked_at IS NULL     AND revocation_reason IS NULL) OR
    (revoked_at IS NOT NULL AND revocation_reason IS NOT NULL))
);

-- 열린 grant는 (user, capability)당 하나. 부분 인덱스 술어에 now()를 쓸 수 없으므로
-- (불변 함수가 아니다) 만료 판정은 인덱스가 아니라 재부여 트랜잭션이 담당한다.
CREATE UNIQUE INDEX user_capability_grants_open_uniq
  ON user_capability_grants (user_id, capability)
  WHERE revoked_at IS NULL;

CREATE INDEX user_capability_grants_lookup
  ON user_capability_grants (user_id, capability, expires_at)
  WHERE revoked_at IS NULL;
