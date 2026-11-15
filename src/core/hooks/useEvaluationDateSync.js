import { useEffect } from 'react';
import { isRedactedPatientRecord, touchPatientRecord } from '../services/patientRecords';
import { getSyncedEvaluationDate } from '../utils/patientCompletion';

// 평가 완료 시 evaluationDate 자동 설정
// suspended: true인 동안 쓰지 않는다 — 로그인 화면이 떠 있는 동안(인트라넷 모드인데 인증 안 됨, 계정 전환 수정). 세션이
// 로컬로 돌아간 그동안 로컬 세션은 편집 권한을 항상 참으로 보아, 이전 사용자가 열람만 하던 환자에 써서 저장 대기로 만들 수 있다.
export function useEvaluationDateSync({ activeId, patients, setPatients, session, suspended = false }) {
  useEffect(() => {
    if (suspended || !activeId) return;
    const p = patients.find(x => x.id === activeId);
    if (!p || isRedactedPatientRecord(p) || !p.data) return;

    const nextEvaluationDate = getSyncedEvaluationDate(p);
    const currentEvaluationDate = p.data?.shared?.evaluationDate || '';
    if (currentEvaluationDate === nextEvaluationDate) return;

    setPatients(prev => prev.map(x =>
      x.id === activeId
        ? touchPatientRecord(
          { ...x, data: { ...x.data, shared: { ...x.data.shared, evaluationDate: nextEvaluationDate } } },
          { session }
        )
        : x
    ));
  }, [activeId, patients, session, setPatients, suspended]);
}
