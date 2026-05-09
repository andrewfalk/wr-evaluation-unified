import { useCallback } from 'react';
import { getModule } from '../moduleRegistry';
import { touchPatientRecord, migratePatientRecords } from '../services/patientRecords';
import { deletePatientOnServer, isConflictError } from '../services/patientServerRepository';
import { createTestPatients } from '../utils/data';
import { showAlert, showConfirm } from '../utils/platform';

export function usePatientCrud({
  activeId, activeModuleId, session, settings,
  patients, setPatients,
  selectedIds, setSelectedIds,
  errors, setErrors,
  setActiveId, setCurrentStepIndex,
  setIntakeShared, setShowHome,
  handleStartIntake,
}) {
  const updatePatient = (updater) => {
    setPatients(prev => prev.map(p =>
      p.id === activeId
        ? touchPatientRecord(
          {
            ...p,
            updatedAt: new Date().toISOString(),
            data: typeof updater === 'function' ? updater(p.data) : { ...p.data, ...updater }
          },
          { session }
        )
        : p
    ));
    if (Object.keys(errors).length) setErrors({});
  };

  const updateShared = (newShared) => {
    updatePatient(d => ({ ...d, shared: newShared }));
  };

  // 모듈 선택 변경 (환자정보 > 모듈 선택 스텝에서)
  const updateActiveModules = useCallback((newActiveModules) => {
    updatePatient(d => {
      const newModules = { ...d.modules };
      for (const moduleId of newActiveModules) {
        if (!newModules[moduleId]) {
          const mod = getModule(moduleId);
          if (mod?.createModuleData) newModules[moduleId] = mod.createModuleData();
        }
      }
      return { ...d, modules: newModules, activeModules: newActiveModules };
    });
  }, [activeId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateModule = (updater) => {
    if (!activeModuleId) return;
    updatePatient(d => ({
      ...d,
      modules: {
        ...d.modules,
        [activeModuleId]: typeof updater === 'function'
          ? updater(d.modules?.[activeModuleId] || {})
          : { ...(d.modules?.[activeModuleId] || {}), ...updater }
      }
    }));
  };

  const updateModuleById = useCallback((moduleId, updater) => {
    updatePatient(d => ({
      ...d,
      modules: {
        ...d.modules,
        [moduleId]: typeof updater === 'function'
          ? updater(d.modules?.[moduleId] || {})
          : { ...(d.modules?.[moduleId] || {}), ...updater }
      }
    }));
  }, [activeId, session]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateDiagnoses = (newDiagnoses) => {
    updatePatient(d => ({ ...d, shared: { ...d.shared, diagnoses: newDiagnoses } }));
  };

  const addPatient = () => { handleStartIntake(); };

  const shouldDeleteOnServer = (patient) => (
    session?.mode === 'intranet' && !!patient?.sync?.serverId
  );

  const markDeleteConflict = (patient, error) => ({
    ...patient,
    sync: {
      ...(patient.sync || {}),
      syncStatus: 'conflict',
      conflict: {
        kind: 'delete',
        code: error?.data?.code || null,
        message: error?.message || error?.data?.error || null,
        serverRevision: error?.data?.currentRevision ?? null,
      },
    },
  });

  const deletePatientsByIds = async (ids) => {
    const idSet = new Set(ids);
    const targets = patients.filter(p => idSet.has(p.id));
    const deletedIds = new Set();
    const conflicts = new Map();
    const failures = [];

    for (const patient of targets) {
      if (!shouldDeleteOnServer(patient)) {
        deletedIds.add(patient.id);
        continue;
      }

      try {
        await deletePatientOnServer(
          patient.sync.serverId,
          patient.sync.revision,
          { session, settings }
        );
        deletedIds.add(patient.id);
      } catch (error) {
        if (error?.status === 404) {
          deletedIds.add(patient.id);
        } else if (isConflictError(error)) {
          conflicts.set(patient.id, error);
        } else {
          failures.push({ patient, error });
        }
      }
    }

    const nextPatients = patients
      .filter(patient => !deletedIds.has(patient.id))
      .map(patient => (
        conflicts.has(patient.id)
          ? markDeleteConflict(patient, conflicts.get(patient.id))
          : patient
      ));

    if (deletedIds.size > 0 || conflicts.size > 0) {
      setPatients(nextPatients);
      if (deletedIds.has(activeId)) {
        setActiveId(nextPatients[0]?.id || null);
        setCurrentStepIndex(0);
      }
    }

    return { deletedIds, conflicts, failures, nextPatients };
  };

  const removePatient = async (id) => {
    const confirmed = await showConfirm('이 환자를 삭제하시겠습니까?');
    if (!confirmed) return;
    const { conflicts, failures, nextPatients } = await deletePatientsByIds([id]);
    if (conflicts.size > 0) {
      await showAlert('Patient was changed on the server. Resolve the conflict before deleting.');
    }
    if (failures.length > 0) {
      await showAlert(`Delete failed. ${failures[0].error?.message || 'Please try again.'}`);
    }
    if (nextPatients.length === 0) setIntakeShared(null);
  };

  const removeSelectedPatients = async () => {
    if (selectedIds.size === 0) return;
    if (selectedIds.size >= patients.length) { await showAlert('최소 1명의 환자는 유지해야 합니다'); return; }
    const confirmed = await showConfirm(`선택된 ${selectedIds.size}명의 환자를 삭제하시겠습니까?`);
    if (!confirmed) return;
    const { deletedIds, conflicts, failures } = await deletePatientsByIds(selectedIds);
    setSelectedIds(new Set([...selectedIds].filter(id => !deletedIds.has(id))));
    if (conflicts.size > 0 || failures.length > 0) {
      await showAlert(`Some patients could not be deleted. Conflicts: ${conflicts.size}, errors: ${failures.length}`);
    }
  };

  const handleBatchImport = (importedPatients, stats) => {
    const nextPatients = migratePatientRecords(importedPatients, { session });
    setPatients(nextPatients);
    if (nextPatients.length > 0) {
      setActiveId(nextPatients[nextPatients.length - 1].id);
      setCurrentStepIndex(0);
    }
    setIntakeShared(null);
    setShowHome(false);
    const doctorNote = session?.mode === 'intranet' && stats.withDoctorName > 0
      ? `, 담당의 배정 예정 ${stats.withDoctorName}명 (서버 동기화 후 확인)`
      : '';
    showAlert(`가져오기 완료: 신규 ${stats.newPatients}명, 상병 ${stats.newDiagnoses}건, 직업 ${stats.newJobs}건 추가 (중복 ${stats.skipped}건 건너뜀)${doctorNote}`);
  };

  const handleLoadTestData = () => {
    const testPatients = migratePatientRecords(createTestPatients(), { session });
    setPatients(testPatients);
    if (testPatients.length > 0) {
      setActiveId(testPatients[0].id);
      setCurrentStepIndex(0);
    }
    setShowHome(false);
    showAlert(`테스트 데이터 로드 완료: ${testPatients.length}명`);
  };

  return {
    updatePatient,
    updateShared,
    updateActiveModules,
    updateModule,
    updateModuleById,
    updateDiagnoses,
    addPatient,
    removePatient,
    removeSelectedPatients,
    handleBatchImport,
    handleLoadTestData,
  };
}
