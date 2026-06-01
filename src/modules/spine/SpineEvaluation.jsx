import { useCallback } from 'react';
import { MddmEvaluation } from './MddmEvaluation';
import { VibrationEvaluation } from './VibrationEvaluation';
import { SpineResultPanel } from './components/SpineResultPanel';
import { VibrationResultPanel } from './components/VibrationResultPanel';

// 척추 모듈 쉘: 편집 탭(activeSpineTab)으로 MDDM/WBV 에디터를 전환하되,
// 계산·출력은 두 평가가 공존한다. 결과 패널은 탭과 무관하게 둘 다 렌더한다(각자 status로 게이트).
export function SpineEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const mod = patient.data.module || {};
  const tab = mod.activeSpineTab || 'mddm';

  const handleTabChange = useCallback((next) => {
    if (next === tab) return;
    updateModule(m => ({ ...m, activeSpineTab: next }));
  }, [tab, updateModule]);

  const methodTabs = (
    <div className="action-group" style={{ marginBottom: 12 }}>
      <button
        className={`btn btn-sm ${tab === 'mddm' ? 'btn-primary' : 'btn-secondary'}`}
        onClick={() => handleTabChange('mddm')}
      >
        요추 압박력(MDDM)
      </button>
      <button
        className={`btn btn-sm ${tab === 'wbv' ? 'btn-primary' : 'btn-secondary'}`}
        onClick={() => handleTabChange('wbv')}
      >
        전신진동(BK2110)
      </button>
    </div>
  );

  return (
    <>
      {tab === 'wbv'
        ? <VibrationEvaluation patient={patient} updateModule={updateModule} methodTabs={methodTabs} />
        : <MddmEvaluation patient={patient} updateModule={updateModule} methodTabs={methodTabs} />}

      {/* 결과 패널은 탭과 무관하게 둘 다 표시 (각자 status unknown이면 null) */}
      <SpineResultPanel calc={calc} />
      <VibrationResultPanel calc={calc?.vibration} />
    </>
  );
}
