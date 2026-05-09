import { useState, useCallback, useRef, useEffect } from 'react';
import { getModule } from '../moduleRegistry';
import { createSharedData } from '../utils/data';
import { createManagedPatient } from '../services/patientRecords';
import { buildSteps } from '../utils/steps';

export function useIntakeWizard({ settings, session, setPatients, setActiveId, setCurrentStepIndex, setShowHome }) {
  const [intakeShared, setIntakeShared] = useState(null);

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const handleStartIntake = useCallback(() => {
    const s = settingsRef.current;
    const newShared = createSharedData();
    newShared.hospitalName = s.hospitalName;
    newShared.department = s.department;
    // In intranet mode, default to the logged-in user's name so the patient is
    // immediately associated with the right doctor without manual entry.
    const intranetName = session?.mode === 'intranet' ? (session?.user?.name || '') : '';
    newShared.doctorName = intranetName || s.doctorName;
    setIntakeShared(newShared);
    setShowHome(false);
  }, [session, setShowHome]);

  const handleIntakeComplete = (selectedModuleIds) => {
    const modulesData = {};
    for (const moduleId of selectedModuleIds) {
      const mod = getModule(moduleId);
      if (mod?.createModuleData) modulesData[moduleId] = mod.createModuleData();
    }
    const p = createManagedPatient(selectedModuleIds, modulesData, { session });
    p.data.shared = { ...intakeShared };
    setPatients(prev => [...prev, p]);
    setActiveId(p.id);
    const newSteps = buildSteps(selectedModuleIds);
    const firstModuleIdx = newSteps.findIndex(s => s.group !== 'shared');
    setCurrentStepIndex(firstModuleIdx >= 0 ? firstModuleIdx : 0);
    setIntakeShared(null);
  };

  return {
    intakeShared,
    setIntakeShared,
    handleStartIntake,
    handleIntakeComplete,
  };
}
