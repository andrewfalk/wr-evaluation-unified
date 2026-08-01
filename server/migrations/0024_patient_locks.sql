-- 환자 단위 TTL lease lock. 동일 계정의 다중 클라이언트 동시 편집을 서버가 실제로
-- 강제하기 위한 락 — revision 기반 optimistic lock(기존)은 최종 안전망으로 그대로 둔다.
--
-- 한 행 = 그 환자에 대한 현재 살아있는 락(없으면 = 잠금 없음, opt-in). lease_token_hash가
-- 소유권의 유일한 증명이다 — client_instance_id/user_id/organization_id는 "같은 탭 재획득"
-- 자기매칭과 표시(holder_name)용 부가 정보일 뿐, 그 자체로 소유권을 증명하지 않는다.
--
-- 스윕 잡 불필요: PK가 patient_id라 테이블 크기가 환자 수 이하로 항상 유한하고, 만료된
-- 행은 다음 acquire의 UPSERT가 그 자리에서 덮어쓴다.
CREATE TABLE patient_locks (
  patient_id         UUID        PRIMARY KEY REFERENCES patient_records(id) ON DELETE CASCADE,
  lease_token_hash   TEXT        NOT NULL,
  client_instance_id UUID        NOT NULL,
  user_id            UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  organization_id    UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  holder_name        TEXT        NOT NULL,
  acquired_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX patient_locks_org_idx ON patient_locks(organization_id);
