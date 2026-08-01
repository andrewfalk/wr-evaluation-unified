import { useMemo } from 'react';
import { isRedactedPatientRecord } from '../services/patientRecords';

// 단일 우선순위 승자를 고르지 않고 이슈 종류별 개수를 모두 반환한다 — 배너가 "충돌 1건 · 락
// 상실 1건"처럼 여러 배지를 동시에 나열할 수 있도록. offline은 patients 배열이 아니라
// syncState(마지막 sync 사이클의 결과)에서 온다 — 개별 환자 상태가 아니라 sync 자체가
// 통신 실패로 끝났는지를 나타내는 값이라 patients를 순회해서는 알 수 없다.
export function useSyncStatusSummary(patients = [], syncState = {}) {
  return useMemo(() => {
    let conflictCount = 0;
    let lockLostCount = 0;
    let pendingCount = 0;

    for (const p of patients) {
      if (isRedactedPatientRecord(p)) continue;
      const status = p?.sync?.syncStatus;
      if (status === 'conflict') {
        if (p.sync?.conflict?.kind === 'lock') lockLostCount += 1;
        else conflictCount += 1;
      } else if (status === 'dirty' || status === 'local-only') {
        pendingCount += 1;
      }
    }

    return {
      conflictCount,
      lockLostCount,
      pendingCount,
      offline: syncState?.status === 'error',
    };
  }, [patients, syncState?.status]);
}
