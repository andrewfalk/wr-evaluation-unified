// 평가 완료 여부에 따라 활성 환자의 평가일자를 맞춘다(REFACTORING_ROADMAP Phase 2 C4, P2-38 — 옛 src/core/hooks/useEvaluationDateSync.js).
//
// 완료 → 오늘(이미 값이 있으면 유지), 미완료 → 빈 값, 같은 값이면 쓰지 않음, 가림 환자 제외, (P2-39c) 편집 권한·현재 환자의 락이
// 없으면 쓰지 않음. 쓰기는 전이
// `patient/evaluationDateSynced`로. effect·deps·가드는 옮기기 전과 같다(T4 `useEvaluationDateSync.characterization.test.jsx`).
//
// 컨테이너 훅(usePatientsContainer) 안이 아니라 같은 모듈의 별도 훅이다 — 계획은 "컨테이너 안으로"였지만,
// ① App 안 effect 실행 순서를 바꾸지 않으려고(옮기기 전처럼 usePatientSync·useWorkspacePersistence·usePatientCrud의 effect 뒤에서 돈다)
// ② flagged P2-39c의 편집 가능 가드가 쓰는 락 상태(usePatientLock)는 컨테이너의 activeId로 만들어져 컨테이너보다 뒤에 있다.
// "액션 뒤 리듀서 후처리"로 바꾸는 것은 게이트 B(불러오기가 목록 교체와 활성 지정 두 번에 걸쳐 일어나 액션마다 후처리하면
// 옛 활성 환자에 쓰는 중간 상태가 생긴다 — 계획 A4, T4가 고정).
import { useEffect } from 'react';
import type { PatientRecord } from '../../types/patient';
import { isRedactedPatientRecord as isRedactedPatientRecordJs } from '../../services/patientRecords';
import { getSyncedEvaluationDate as getSyncedEvaluationDateJs } from '../../utils/patientCompletion';
import { canEditPatient as canEditPatientJs } from '../../utils/patientOwnership';
import { requiresLock as requiresLockJs } from '../../hooks/usePatientLock';
import { getLockToken as getLockTokenJs } from '../../services/lockTokenStore';
import { patientTx, type PatientTransition } from './transitions';

// JS 유틸은 호출 시점에만 읽는다(transitions.ts와 같은 이유 — 일부 export만 가진 vi.mock).
function isRedactedPatientRecord(patient: PatientRecord): boolean {
  return (isRedactedPatientRecordJs as unknown as (p: PatientRecord) => boolean)(patient);
}
function getSyncedEvaluationDate(patient: PatientRecord): string {
  return (getSyncedEvaluationDateJs as unknown as (p: PatientRecord) => string)(patient);
}

export interface LockStateLike {
  status?: string;
}

/**
 * (flagged P2-39c) 평가일자를 자동으로 써도 되는가 — 편집 권한이 있고, 락 대상이면 **이 환자의** 락을 들고 있을 때만.
 * lockState에는 환자 id가 없고 전환 뒤 acquiring으로 바꾸는 것은 effect라서, A의 락을 들고 B로 전환한 첫 렌더에는 A의 held가
 * 그대로 보인다 — 락 토큰은 환자 id별로 저장되고(전환 시 이전 환자 것은 cleanup에서 지워짐, 새 환자 것은 acquire 성공 뒤에만
 * 생김) 그 창을 막는다. usePatientSync의 push 허용(getPushEligibility)이 쓰는 "held + 토큰 있음"과 같은 기준(Codex 계획 리뷰 3회차).
 */
export function canAutoWritePatient(
  patient: PatientRecord,
  session: unknown,
  lockState: LockStateLike | null | undefined,
  getLockToken: (patientId: string) => unknown = getLockTokenJs as unknown as (patientId: string) => unknown,
): boolean {
  const canEdit = (canEditPatientJs as unknown as (p: PatientRecord, s: unknown) => boolean)(patient, session);
  if (!canEdit) return false;
  const needsLock = (requiresLockJs as unknown as (p: PatientRecord, s: unknown) => boolean)(patient, session);
  if (!needsLock) return true;
  return lockState?.status === 'held' && getLockToken(patient.id) != null;
}

export interface EvaluationDateSyncArgs {
  activeId: string | null;
  patients: PatientRecord[];
  setPatients: (transition: PatientTransition) => void;
  session: unknown;
  /** usePatientLock의 lockState(P2-39c) — 락을 얻은 뒤(새 객체) 다시 판정하려고 deps에 둔다. */
  lockState?: LockStateLike | null;
}

export function useEvaluationDateSync({ activeId, patients, setPatients, session, lockState }: EvaluationDateSyncArgs): void {
  useEffect(() => {
    if (!activeId) return;
    const p = patients.find(x => x.id === activeId);
    if (!p || isRedactedPatientRecord(p) || !p.data) return;
    // (flagged P2-39c) 편집 권한·현재 환자의 락이 없으면 쓰지 않는다 — 옮기기 전에는 다른 의사 담당 환자에도 써서 dirty로 만들었다(T4).
    if (!canAutoWritePatient(p, session, lockState)) return;

    const nextEvaluationDate = getSyncedEvaluationDate(p);
    const currentEvaluationDate = p.data?.shared?.evaluationDate || '';
    if (currentEvaluationDate === nextEvaluationDate) return;

    setPatients(patientTx.evaluationDateSynced({ id: activeId, evaluationDate: nextEvaluationDate, session }));
  }, [activeId, patients, session, setPatients, lockState]);
}
