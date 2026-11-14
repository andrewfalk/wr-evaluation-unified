// 평가 완료 여부에 따라 활성 환자의 평가일자를 맞춘다(REFACTORING_ROADMAP Phase 2 C4, P2-38 — 옛 src/core/hooks/useEvaluationDateSync.js).
//
// 완료 → 오늘(이미 값이 있으면 유지), 미완료 → 빈 값, 같은 값이면 쓰지 않음, 가림 환자 제외. 쓰기는 전이
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
import { patientTx, type PatientTransition } from './transitions';

// JS 유틸은 호출 시점에만 읽는다(transitions.ts와 같은 이유 — 일부 export만 가진 vi.mock).
function isRedactedPatientRecord(patient: PatientRecord): boolean {
  return (isRedactedPatientRecordJs as unknown as (p: PatientRecord) => boolean)(patient);
}
function getSyncedEvaluationDate(patient: PatientRecord): string {
  return (getSyncedEvaluationDateJs as unknown as (p: PatientRecord) => string)(patient);
}

export interface EvaluationDateSyncArgs {
  activeId: string | null;
  patients: PatientRecord[];
  setPatients: (transition: PatientTransition) => void;
  session: unknown;
}

export function useEvaluationDateSync({ activeId, patients, setPatients, session }: EvaluationDateSyncArgs): void {
  useEffect(() => {
    if (!activeId) return;
    const p = patients.find(x => x.id === activeId);
    if (!p || isRedactedPatientRecord(p) || !p.data) return;

    const nextEvaluationDate = getSyncedEvaluationDate(p);
    const currentEvaluationDate = p.data?.shared?.evaluationDate || '';
    if (currentEvaluationDate === nextEvaluationDate) return;

    setPatients(patientTx.evaluationDateSynced({ id: activeId, evaluationDate: nextEvaluationDate, session }));
  }, [activeId, patients, session, setPatients]);
}
