import { useState } from 'react';

export function useStepNavigation({
  steps, activeId, setActiveId, setShowSidebar,
  // 종합소견을 편집 중일 때 다른 스텝·환자로 이동하면 AssessmentStep이 언마운트되어
  // 저장하지 않은 draft가 사라진다 — 이동 자체를 막는다(대상이 활성 환자와 같으면 통과).
  hasUnsavedAssessmentDraft = false,
  onBlockedByUnsavedDraft,
}) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [lastStepPerPatient, setLastStepPerPatient] = useState({});

  const goToStep = (index) => {
    if (index < 0 || index >= steps.length || index === currentStepIndex) return;
    if (hasUnsavedAssessmentDraft) { onBlockedByUnsavedDraft?.(); return; }
    if (activeId) setLastStepPerPatient(prev => ({ ...prev, [activeId]: currentStepIndex }));
    setCurrentStepIndex(index);
  };

  const goNext = () => goToStep(currentStepIndex + 1);
  const goPrev = () => goToStep(currentStepIndex - 1);

  const switchPatient = (patientId) => {
    // 이미 활성인 환자를 다시 선택한 경우: 스텝은 그대로 둔다. 아래 lastStepPerPatient
    // 조회로 그냥 통과시키면(예: 사용자가 이미 여러 스텝을 이동해 lastStepPerPatient[activeId]가
    // currentStepIndex와 달라진 상태) 현재 스텝에서 벗어나며 AssessmentStep이 재마운트되어
    // 편집 중이던 draft를 잃는다 — dirty 여부와 무관하게 항상 no-op이어야 한다.
    if (patientId === activeId) { setShowSidebar(false); return; }
    if (hasUnsavedAssessmentDraft) { onBlockedByUnsavedDraft?.(); return; }
    if (activeId) setLastStepPerPatient(prev => ({ ...prev, [activeId]: currentStepIndex }));
    setActiveId(patientId);
    setCurrentStepIndex(lastStepPerPatient[patientId] || 0);
    setShowSidebar(false);
  };

  return {
    currentStepIndex,
    setCurrentStepIndex,
    goToStep,
    goNext,
    goPrev,
    switchPatient,
  };
}
