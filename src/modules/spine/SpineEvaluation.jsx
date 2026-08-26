import { useCallback, useEffect, useState } from 'react';
import { MddmEvaluation } from './MddmEvaluation';
import { VibrationEvaluation } from './VibrationEvaluation';
import { SpineResultPanel } from './components/SpineResultPanel';
import { VibrationResultPanel } from './components/VibrationResultPanel';

// 척추 모듈 쉘: 편집 탭(activeSpineTab)으로 MDDM/WBV 에디터를 전환하되,
// 계산·출력은 두 평가가 공존한다. 결과 패널은 탭과 무관하게 둘 다 렌더한다(각자 status로 게이트).
export function SpineEvaluation({ patient, calc, activeTab, updateModule, errors, canMutate = true }) {
  const mod = patient.data.module || {};
  const savedTab = mod.activeSpineTab || 'mddm';
  // MDDM/WBV 탭은 화면 전환인 동시에 activeSpineTab을 저장한다(AssessmentTab의 패턴 그룹/개별
  // 카드 토글과 동일한 이중 용도). 비담당 환자 조회 시 저장을 시도해도 usePatientCrud의 silent
  // guard에 막혀 아무 일도 안 일어나므로, canMutate=false일 때는 로컬 오버라이드로만 전환한다.
  const [readOnlyTabOverride, setReadOnlyTabOverride] = useState(null);
  useEffect(() => {
    setReadOnlyTabOverride(null);
  }, [patient.id, canMutate, savedTab]);
  const tab = (!canMutate && readOnlyTabOverride) ? readOnlyTabOverride : savedTab;

  const handleTabChange = useCallback((next) => {
    if (next === tab) return;
    if (!canMutate) {
      setReadOnlyTabOverride(next);
      return;
    }
    updateModule(m => ({ ...m, activeSpineTab: next }));
  }, [tab, canMutate, updateModule]);

  const methodTabs = (
    <div className="action-group" style={{ marginBottom: 12 }}>
      <button
        className={`btn btn-sm ${tab === 'mddm' ? 'btn-primary' : 'btn-secondary'}`}
        data-readonly-allow
        onClick={() => handleTabChange('mddm')}
      >
        요추 압박력(MDDM)
      </button>
      <button
        className={`btn btn-sm ${tab === 'wbv' ? 'btn-primary' : 'btn-secondary'}`}
        data-readonly-allow
        onClick={() => handleTabChange('wbv')}
      >
        전신진동(BK2110)
      </button>
    </div>
  );

  return (
    <>
      {tab === 'wbv'
        ? <VibrationEvaluation patient={patient} updateModule={updateModule} methodTabs={methodTabs} canMutate={canMutate} />
        : <MddmEvaluation patient={patient} updateModule={updateModule} methodTabs={methodTabs} canMutate={canMutate} />}

      {/* 결과 패널은 탭과 무관하게 둘 다 표시 (각자 status unknown이면 null) */}
      <SpineResultPanel calc={calc} />
      <VibrationResultPanel calc={calc?.vibration} />
    </>
  );
}
