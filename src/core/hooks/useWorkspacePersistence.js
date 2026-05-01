import { useState, useEffect } from 'react';
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
import { clonePatientRecordForImport, migratePatientRecords } from '../services/patientRecords';

export function useWorkspacePersistence({
  patients, setPatients,
  session, settings, serverConfig,
  setActiveId, setCurrentStepIndex, setIntakeShared, setShowHome,
  setShowSaveModal, setShowLoadModal,
  disabled = false,
}) {
  const [savedItems, setSavedItems] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [lastAutoSave, setLastAutoSave] = useState(null);
  const [legacyItems, setLegacyItems] = useState(null);

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
    if (disabled) return;
    loadAutoSavedWorkspace({ session, settings, serverConfig }).then(saved => {
      if (saved) {
        const time = new Date(saved.savedAt).toLocaleString('ko-KR');
        showConfirm(`이전 자동 저장 데이터가 있습니다 (${time}).\n이어서 작업하시겠습니까?`).then(ok => {
          if (ok && saved.patients?.length) {
            setPatients(saved.patients);
            setActiveId(saved.patients[0].id);
            setCurrentStepIndex(0);
          }
          clearAutoSavedWorkspace({ session, settings, serverConfig });
        });
      }
    });
  }, [disabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // 자동 저장
  useEffect(() => {
    if (disabled || !settings.autoSaveInterval || patients.length === 0) return;
    const timer = setTimeout(() => {
      saveAutoSavedWorkspace({ patients, session, settings, serverConfig });
      setLastAutoSave(new Date());
    }, settings.autoSaveInterval * 1000);
    return () => clearTimeout(timer);
  }, [
    disabled,
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
    if (!saveName.trim()) { await showAlert('저장명 필수'); return; }
    if (hasDuplicateWorkspaceName(saveName, savedItems)) {
      const confirmed = await showConfirm(`"${saveName}" 이름의 저장 데이터가 이미 존재합니다. 덮어쓰시겠습니까?`);
      if (!confirmed) return;
    }
    try {
      const items = await saveWorkspaceSnapshot({ name: saveName, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await showAlert('저장됨');
    } catch (err) {
      await showAlert(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleOverwriteSave = async (item) => {
    const confirmed = await showConfirm(`"${item.name}"에 덮어쓰시겠습니까?`);
    if (!confirmed) return;
    try {
      const items = await saveWorkspaceSnapshot({ name: item.name, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await showAlert('저장됨');
    } catch (err) {
      await showAlert(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleLoad = async (item, mode = 'overwrite') => {
    if (mode === 'overwrite') {
      const confirmed = await showConfirm('현재 데이터를 덮어쓰시겠습니까?');
      if (!confirmed) return;
      const nextPatients = migratePatientRecords(item.patients || [], { session });
      setPatients(nextPatients);
      setActiveId(nextPatients[0]?.id || null);
    } else {
      const newPatients = (item.patients || []).map(p => clonePatientRecordForImport(p, { session }));
      setPatients(prev => [...prev, ...newPatients]);
      setActiveId(newPatients[0]?.id || null);
    }
    setCurrentStepIndex(0);
    setShowLoadModal(false);
    setIntakeShared(null);
    setShowHome(false);
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
