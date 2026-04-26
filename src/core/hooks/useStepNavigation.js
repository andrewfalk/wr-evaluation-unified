import { useState } from 'react';

export function useStepNavigation({ steps, activeId, setActiveId, setShowSidebar }) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const [lastStepPerPatient, setLastStepPerPatient] = useState({});

  const goToStep = (index) => {
    if (index >= 0 && index < steps.length) {
      if (activeId) setLastStepPerPatient(prev => ({ ...prev, [activeId]: currentStepIndex }));
      setCurrentStepIndex(index);
    }
  };

  const goNext = () => goToStep(currentStepIndex + 1);
  const goPrev = () => goToStep(currentStepIndex - 1);

  const switchPatient = (patientId) => {
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
