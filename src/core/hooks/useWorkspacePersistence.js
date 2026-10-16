import { useState, useEffect, useRef } from 'react';
import { showAlert, showConfirm } from '../utils/platform';
import {
  clearAutoSavedWorkspace,
  deleteWorkspaceSnapshot,
  hasDuplicateWorkspaceName,
  loadAutoSavedWorkspace,
  loadSavedWorkspaces,
  migrateWorkspaceStorage,
  saveAutoSavedWorkspace,
  saveWorkspaceSnapshot,
} from '../services/workspaceRepository';
import { applyWorkspaceSaveAck } from '../services/patientServerRepository';
import {
  clonePatientRecordForImport,
  isRedactedPatientRecord,
  migratePatientRecords,
} from '../services/patientRecords';
import {
  isIntranetWorkspaceMode,
  shouldUseWorkspaceAutosave,
} from '../utils/workspaceAutosavePolicy';

export function getLoadablePatientsFromSnapshot(patients = [], context = {}) {
  const migrated = migratePatientRecords(patients || [], context);
  const loadablePatients = migrated.filter(patient => !isRedactedPatientRecord(patient));

  return {
    patients: loadablePatients,
    failedCount: migrated.length - loadablePatients.length,
    totalCount: migrated.length,
  };
}

export function buildLoadFailureMessage({ failedCount = 0, totalCount = 0 } = {}) {
  if (!failedCount) return '';
  return `불러오기한 환자 목록에 삭제된 환자가 포함되어 있어 작업 목록에서 제외했습니다. (실패 ${failedCount}건 / 총 ${totalCount}건)`;
}

// 워크스페이스 저장 결과(HF1) 중 사용자가 알아야 할 것만 문장으로 만든다. 스냅샷 목록(저장 항목)은 항상
// 저장되지만, 환자 데이터는 담당의·최신 revision·편집 락 검사를 통과한 환자만 서버 기록에 반영된다.
export function buildSaveAckMessage(ack) {
  if (!ack) return '';
  const skipped = reason => (ack.skipped || []).filter(s => s.reason === reason).length;
  const lines = [];
  if (skipped('not_assigned')) lines.push(`담당의가 아니어서 환자 데이터가 서버에 반영되지 않은 환자 ${skipped('not_assigned')}명 (저장 목록에는 포함됨)`);
  if (skipped('error')) lines.push(`서버 저장 중 오류가 난 환자 ${skipped('error')}명`);
  if (ack.conflicts?.length) lines.push(`서버에 더 새로운 버전이 있어 반영되지 않은 환자 ${ack.conflicts.length}명 — 충돌을 해결한 뒤 다시 저장하세요`);
  if (ack.lockedByOther?.length) lines.push(`다른 사용자가 편집 중이라 반영되지 않은 환자 ${ack.lockedByOther.length}명`);
  return lines.join('\n');
}

async function showLoadFailureNotice(loadResult) {
  if (!loadResult) return;
  const message = buildLoadFailureMessage(loadResult);
  if (message) await showAlert(message);
}

export function useWorkspacePersistence({
  patients, setPatients,
  session, settings, serverConfig,
  setActiveId, setCurrentStepIndex, setIntakeShared, setShowHome,
  setShowSaveModal, setShowLoadModal,
  disabled = false,
  dirtyAssessmentPatientId, onBlockedByUnsavedDraft,
}) {
  const [savedItems, setSavedItems] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [lastAutoSave, setLastAutoSave] = useState(null);
  const [legacyItems, setLegacyItems] = useState(null);
  const autosaveRestoreCheckedRef = useRef(false);
  const intranetWorkspaceMode = isIntranetWorkspaceMode({ session, settings });
  const autosaveEnabled = shouldUseWorkspaceAutosave({ disabled, session, settings });

  useEffect(() => {
    migrateWorkspaceStorage();
  }, []);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    loadSavedWorkspaces({ session, settings, serverConfig })
      .then(items => {
        if (!cancelled) setSavedItems(items);
      })
      .catch(error => {
        console.error('[workspace-load]', error);
      });
    return () => { cancelled = true; };
  }, [
    disabled,
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.integrationMode,
    settings?.apiBaseUrl,
    serverConfig?.localFallbackAllowed,
  ]);

  // 자동 저장 복원 (초기 1회만) — config 준비 전에는 실행하지 않음
  useEffect(() => {
    if (!autosaveEnabled) {
      autosaveRestoreCheckedRef.current = false;
      return;
    }
    if (autosaveRestoreCheckedRef.current) return;
    autosaveRestoreCheckedRef.current = true;

    loadAutoSavedWorkspace({ session, settings, serverConfig }).then(saved => {
      if (saved) {
        const time = new Date(saved.savedAt).toLocaleString('ko-KR');
        showConfirm(`이전 자동 저장 데이터가 있습니다 (${time}).\n이어서 작업하시겠습니까?`).then(async ok => {
          if (ok && saved.patients?.length) {
            const loadResult = getLoadablePatientsFromSnapshot(saved.patients, { session });
            setPatients(loadResult.patients);
            setActiveId(loadResult.patients[0]?.id || null);
            setCurrentStepIndex(0);
            await showLoadFailureNotice(loadResult);
          }
          clearAutoSavedWorkspace({ session, settings, serverConfig })
            .catch(error => {
              console.warn('[autosave-clear]', error);
            });
        });
      }
    });
  }, [autosaveEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (intranetWorkspaceMode && lastAutoSave) {
      setLastAutoSave(null);
    }
  }, [intranetWorkspaceMode, lastAutoSave]);

  // 자동 저장
  useEffect(() => {
    if (!autosaveEnabled || !settings?.autoSaveInterval || patients.length === 0) return;
    const timer = setTimeout(() => {
      saveAutoSavedWorkspace({ patients, session, settings, serverConfig })
        .then(() => {
          setLastAutoSave(new Date());
        })
        .catch(error => {
          console.warn('[autosave-save]', error);
        });
    }, settings.autoSaveInterval * 1000);
    return () => clearTimeout(timer);
  }, [
    autosaveEnabled,
    patients,
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.autoSaveInterval,
    settings?.integrationMode,
    settings?.apiBaseUrl,
    serverConfig?.localFallbackAllowed,
  ]);

  const handleSave = async () => {
    const existingItem = savedItems.find(item => item.name === saveName);
    if (!saveName.trim()) { await showAlert('저장명 필수'); return; }
    if (hasDuplicateWorkspaceName(saveName, savedItems)) {
      const confirmed = await showConfirm(`"${saveName}" 이름의 저장 데이터가 이미 존재합니다. 덮어쓰시겠습니까?`);
      if (!confirmed) return;
    }
    try {
      const { items, ack } = await saveWorkspaceSnapshot({ id: existingItem?.id, name: saveName, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setPatients(prev => applyWorkspaceSaveAck(prev, patients, ack));
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await showAlert(['저장됨', buildSaveAckMessage(ack)].filter(Boolean).join('\n'));
    } catch (err) {
      await showAlert(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleOverwriteSave = async (item) => {
    const confirmed = await showConfirm(`"${item.name}"에 덮어쓰시겠습니까?`);
    if (!confirmed) return;
    try {
      const { items, ack } = await saveWorkspaceSnapshot({ id: item.id, name: item.name, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setPatients(prev => applyWorkspaceSaveAck(prev, patients, ack));
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await showAlert(['저장됨', buildSaveAckMessage(ack)].filter(Boolean).join('\n'));
    } catch (err) {
      await showAlert(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleLoad = async (item, mode = 'overwrite') => {
    // 저장된 스냅샷을 불러오면 환자 목록·활성 환자가 통째로 바뀐다 — 지금 종합소견을
    // 편집 중이면 어느 환자 기준으로 저장될지 불명확해지므로 먼저 마무리하게 한다.
    if (dirtyAssessmentPatientId) { onBlockedByUnsavedDraft?.(); return; }
    let loadResultForNotice = null;
    if (mode === 'overwrite') {
      const confirmed = await showConfirm('현재 데이터를 덮어쓰시겠습니까?');
      if (!confirmed) return;
      const loadResult = getLoadablePatientsFromSnapshot(item.patients || [], { session });
      setPatients(loadResult.patients);
      setActiveId(loadResult.patients[0]?.id || null);
      loadResultForNotice = loadResult;
    } else {
      const loadResult = getLoadablePatientsFromSnapshot(item.patients || [], { session });
      const newPatients = loadResult.patients
        .map(p => clonePatientRecordForImport(p, { session }))
        .filter(Boolean);
      setPatients(prev => [...prev, ...newPatients]);
      setActiveId(newPatients[0]?.id || null);
      loadResultForNotice = loadResult;
    }
    setCurrentStepIndex(0);
    setShowLoadModal(false);
    setIntakeShared(null);
    setShowHome(false);
    await showLoadFailureNotice(loadResultForNotice);
  };

  const handleDelete = async (id) => {
    const confirmed = await showConfirm('삭제하시겠습니까?');
    if (confirmed) {
      try {
        const items = await deleteWorkspaceSnapshot({ id, savedItems, session, settings, serverConfig });
        setSavedItems(items);
      } catch (err) {
        await showAlert(`삭제에 실패했습니다. ${err?.message || '서버 오류'}`);
      }
    }
  };

  const openLoadModal = () => {
    setShowLoadModal(true);
    if (window.electron?.loadLegacyData) {
      // Electron: IPC로 구형 앱 LevelDB 읽기
      window.electron.loadLegacyData().then(result => {
        if (result?.debug) console.log('[legacy-debug]', result.debug);
        const legacyData = result?.data || result; // 새 형식({ debug, data }) 또는 기존 형식 호환
        if (legacyData?.savedItems) {
          try {
            setLegacyItems(legacyData.savedItems.map(item => ({
              ...item,
              patients: item.patients ? migratePatientRecords(item.patients, { session }) : []
            })));
          } catch (e) {
            console.error('[legacy-migrate]', e);
            setLegacyItems(null);
          }
        } else {
          setLegacyItems(null);
        }
      }).catch((e) => { console.error('[legacy-error]', e); setLegacyItems(null); });
    } else {
      // 웹: 같은 도메인이면 localStorage 직접 접근
      try {
        const legacy = localStorage.getItem('wrEvaluationSavedItems');
        if (legacy) {
          const items = JSON.parse(legacy);
          setLegacyItems(items.map(item => ({
            ...item,
            patients: item.patients ? migratePatientRecords(item.patients, { session }) : []
          })));
        } else {
          setLegacyItems(null);
        }
      } catch { setLegacyItems(null); }
    }
  };

  return {
    savedItems, setSavedItems,
    saveName, setSaveName,
    lastAutoSave,
    legacyItems,
    handleSave, handleOverwriteSave, handleLoad, handleDelete,
    openLoadModal,
  };
}
