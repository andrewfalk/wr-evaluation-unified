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
    if (hasUnsavedAssessmentDraft && patientId !== activeId) { onBlockedByUnsavedDraft?.(); return; }
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
