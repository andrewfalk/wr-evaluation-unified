-- 0027_orphan_patient_persons.sql
-- 고아 patient_persons 정리 — "유령 등록번호" 해제.
--
-- 배경: DELETE /api/patients/:id 는 patient_records 만 soft-delete 하고
-- patient_persons 는 손대지 않았다. 저장소 전체에서 patient_persons.deleted_at 을
-- 설정하는 코드 경로가 아예 없었기 때문에, 환자를 삭제해도 person 행이
-- deleted_at IS NULL 로 살아남아 (organization_id, patient_no) 유니크 공간을 계속
-- 점유했다. 그 결과 같은 등록번호로 재입력하면 resolvePatientPersonId 가 옛 person 을
-- 찾아내고, 저장된 birth_date 가 다르면 PATIENT_IDENTITY_CONFLICT(409) 를 던져
-- 사용자가 삭제-재입력으로도 빠져나올 수 없는 상태가 됐다.
--
-- 이는 0006_patient_no_audit_retention.sql 의 인덱스 주석
-- ("Soft-deleted patients do not reserve the number") 과 정면으로 어긋나는 상태였다.
-- 이 마이그레이션은 그 의도대로 기존 데이터를 되돌린다.
--
-- 대상: 살아있는 patient_records 가 하나도 없는데 아직 활성 상태인 person.
-- 살아있는 case 가 1건이라도 있으면 건드리지 않는다.
--
-- 재실행 안전(idempotent): 이미 deleted_at 이 설정된 행은 WHERE 절에서 제외되므로
-- 두 번 실행해도 결과가 같고, 첫 실행 이후에는 0행이 갱신된다.

UPDATE patient_persons AS pp
SET deleted_at = now()
WHERE pp.deleted_at IS NULL
  AND pp.patient_no IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM patient_records pr
    WHERE pr.patient_person_id = pp.id
      AND pr.deleted_at IS NULL
  );

COMMENT ON COLUMN patient_persons.deleted_at IS
  'Set when the last active patient_records row referencing this person is soft-deleted. Releases (organization_id, patient_no) via patient_persons_org_patient_no_uniq so the number can be reused.';
