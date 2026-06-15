import { useEffect } from 'react';
import { isRedactedPatientRecord, touchPatientRecord } from '../services/patientRecords';
import { getSyncedEvaluationDate } from '../utils/patientCompletion';

// 평가 완료 시 evaluationDate 자동 설정
export function useEvaluationDateSync({ activeId, patients, setPatients, session }) {
  useEffect(() => {
    if (!activeId) return;
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
  }, [activeId, patients, session, setPatients]);
}
