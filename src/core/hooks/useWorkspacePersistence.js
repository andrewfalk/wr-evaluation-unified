// @ts-nocheck
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
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
import { useGuardedDialogs } from '../../app/useWorkspaceLifetime';
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

async function showLoadFailureNotice(loadResult, alert = showAlert) {
  if (!loadResult) return;
  const message = buildLoadFailureMessage(loadResult);
  if (message) await alert(message);
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
  // 화면 수명(계정 전환 수정 AS-4) — 화면이 내려간 뒤에는 기다리던 처리의 저장소 쓰기·삭제·알림·확인창을 하지 않는다.
  const { isAlive, alertAlive, confirmAlive } = useGuardedDialogs(showAlert, showConfirm);
  // 자동저장 복원을 수락했을 때 저장본 삭제는 복원된 목록이 커밋된 뒤에 한다(아래 layout effect). 그 전에 화면이 내려가면
  // 삭제하지 않아 저장본이 디스크에 남는다(다음에 로컬 모드에서 다시 복원 안내).
  const [restoreClearRequest, setRestoreClearRequest] = useState(null);
  const restoreClearDoneRef = useRef(null);
  // 진행 중인 자동저장 복원(읽기 → 확인창 → 수락이면 복원 목록 커밋까지). 로그인 직전 로컬 보존(useLocalWorkBeforeLogin)이
  // 이것이 끝날 때까지 기다린다 — 복원이 끝나기 전에 보존이 끝나 로그인하면 복원 목록이 저장되지 않은 채 사라진다.
  const restorePendingRef = useRef(null);
  const endRestore = (entry) => {
    if (!entry) return;
    entry.resolve();
    if (restorePendingRef.current === entry) restorePendingRef.current = null;
  };
  const waitForAutosaveRestore = useCallback(() => restorePendingRef.current?.promise ?? Promise.resolve(), []);
  // (언마운트 정리로 풀지 않는다 — StrictMode의 시험 언마운트가 진행 중 표시를 지운다. 모든 경로가 끝에서 풀고, 기다리는 쪽
  // 로그인 화면도 같은 화면이라 함께 내려간다.)
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
      // 자동저장 문맥을 벗어나면(인트라넷으로 전환) 진행 중이던 복원은 끝낸다 — 늦게 수락돼도 적용하지 않고 저장본을 남긴다.
      endRestore(restorePendingRef.current);
      return;
    }
    if (autosaveRestoreCheckedRef.current) return;
    autosaveRestoreCheckedRef.current = true;

    const options = { session, settings, serverConfig };
    let resolveRestore;
    const entry = { promise: new Promise((r) => { resolveRestore = r; }), resolve: () => resolveRestore() };
    // 이전 복원이 아직 진행 중이면(모드를 오가 다시 시작됨) 끝내고 대체한다 — 늦은 응답은 적용하지 않는다.
    endRestore(restorePendingRef.current);
    restorePendingRef.current = entry;
    // 이 복원이 아직 유효한가 — 화면이 떠 있고, 다른 복원으로 대체되지 않았다.
    const stillCurrent = () => isAlive() && restorePendingRef.current === entry;
    loadAutoSavedWorkspace(options).then(saved => {
      // 읽는 동안 화면이 내려갔으면(계정 전환) 묻지도 지우지도 않는다 — 로컬 자동저장의 유일한 사본일 수 있다.
      if (!saved || !stillCurrent()) { endRestore(entry); return; }
      const time = new Date(saved.savedAt).toLocaleString('ko-KR');
      confirmAlive(`이전 자동 저장 데이터가 있습니다 (${time}).\n이어서 작업하시겠습니까?`).then(async ok => {
        // 확인하는 동안 화면이 내려갔거나 대체됐으면 아무것도 하지 않는다(수락이든 거절이든 저장본을 남긴다).
        if (!stillCurrent()) { endRestore(entry); return; }
        if (ok && saved.patients?.length) {
          const loadResult = getLoadablePatientsFromSnapshot(saved.patients, { session });
          setPatients(loadResult.patients);
          setActiveId(loadResult.patients[0]?.id || null);
          setCurrentStepIndex(0);
          setRestoreClearRequest({ options, entry }); // 같은 배치 — 저장본 삭제는 복원 목록이 커밋된 뒤(아래 layout effect)
          await showLoadFailureNotice(loadResult, alertAlive);
          return;
        }
        // 거절: 저장본 삭제가 끝난 뒤에 보존 대기를 푼다(삭제와 재기록의 순서를 저장소에 기대지 않는다).
        clearAutoSavedWorkspace(options)
          .catch(error => {
            console.warn('[autosave-clear]', error);
          })
          .finally(() => { endRestore(entry); });
      });
    }, () => { endRestore(entry); });
  }, [autosaveEnabled]); // eslint-disable-line react-hooks/exhaustive-deps

  // 복원된 목록이 커밋된 뒤 저장본을 지운다. layout effect라서 같은 커밋에서 로그인 직전 보존의 목록 ref
  // (src/app/useLocalWorkBeforeLogin)가 이미 복원 목록을 가리킨다 — "저장본이 지워졌다 ⇒ 로그인 직전 보존이 그 목록을 본다".
  // (passive effect면 커밋과 이 삭제 사이에 로그인 직전 보존의 재기록이 끼어 그 기록을 지울 수 있다.)
  useLayoutEffect(() => {
    if (!restoreClearRequest || restoreClearDoneRef.current === restoreClearRequest) return;
    restoreClearDoneRef.current = restoreClearRequest;
    // 복원 목록이 커밋됐다(같은 커밋에서 로그인 직전 보존의 목록 ref도 갱신된다). 저장본 삭제가 끝난 뒤에 기다리던 보존을
    // 푼다 — 삭제가 늦게 끝나 방금 재기록한 사본을 지우지 않게(삭제와 재기록의 순서를 저장소에 기대지 않는다).
    const { entry } = restoreClearRequest;
    clearAutoSavedWorkspace(restoreClearRequest.options)
      .catch(error => {
        console.warn('[autosave-clear]', error);
      })
      .finally(() => { endRestore(entry); });
  }, [restoreClearRequest]);

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
    if (!saveName.trim()) { await alertAlive('저장명 필수'); return; }
    if (hasDuplicateWorkspaceName(saveName, savedItems)) {
      const confirmed = await confirmAlive(`"${saveName}" 이름의 저장 데이터가 이미 존재합니다. 덮어쓰시겠습니까?`);
      if (!confirmed) return;
    }
    try {
      const { items, ack } = await saveWorkspaceSnapshot({ id: existingItem?.id, name: saveName, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setPatients(prev => applyWorkspaceSaveAck(prev, patients, ack));
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await alertAlive(['저장됨', buildSaveAckMessage(ack)].filter(Boolean).join('\n'));
    } catch (err) {
      await alertAlive(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleOverwriteSave = async (item) => {
    const confirmed = await confirmAlive(`"${item.name}"에 덮어쓰시겠습니까?`);
    if (!confirmed) return;
    try {
      const { items, ack } = await saveWorkspaceSnapshot({ id: item.id, name: item.name, patients, savedItems, session, settings, serverConfig });
      setSavedItems(items);
      setPatients(prev => applyWorkspaceSaveAck(prev, patients, ack));
      setLastAutoSave(null);
      setShowSaveModal(false);
      setSaveName('');
      await alertAlive(['저장됨', buildSaveAckMessage(ack)].filter(Boolean).join('\n'));
    } catch (err) {
      await alertAlive(`저장에 실패했습니다. ${err?.message || '서버 오류'}`);
    }
  };

  const handleLoad = async (item, mode = 'overwrite') => {
    // 저장된 스냅샷을 불러오면 환자 목록·활성 환자가 통째로 바뀐다 — 지금 종합소견을
    // 편집 중이면 어느 환자 기준으로 저장될지 불명확해지므로 먼저 마무리하게 한다.
    if (dirtyAssessmentPatientId) { onBlockedByUnsavedDraft?.(); return; }
    let loadResultForNotice = null;
    if (mode === 'overwrite') {
      const confirmed = await confirmAlive('현재 데이터를 덮어쓰시겠습니까?');
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
    await showLoadFailureNotice(loadResultForNotice, alertAlive);
  };

  const handleDelete = async (id) => {
    const confirmed = await confirmAlive('삭제하시겠습니까?');
    if (confirmed) {
      try {
        const items = await deleteWorkspaceSnapshot({ id, savedItems, session, settings, serverConfig });
        setSavedItems(items);
      } catch (err) {
        await alertAlive(`삭제에 실패했습니다. ${err?.message || '서버 오류'}`);
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
    waitForAutosaveRestore,
  };
}
