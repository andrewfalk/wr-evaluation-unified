import { useCallback } from 'react';
import { resolvePatientConflictInList } from '../services/patientConflictResolution';
import { correctPatientIdentity, deletePatientOnServer } from '../services/patientServerRepository';
import { showAlert, showConfirm } from '../utils/platform';

// 환자 동기화 충돌 해결 핸들러
export function useConflictResolution({
  setPatients, activeId, setActiveId, setCurrentStepIndex,
  session, settings, setConflictPatientId,
}) {
  const applyResolvedConflict = (patientId, resolution, options = {}) => {
    setPatients(prev => {
      const next = resolvePatientConflictInList(prev, patientId, resolution, options);
      if (activeId === patientId && !next.some(p => p.id === patientId)) {
        queueMicrotask(() => {
          setActiveId(next[0]?.id || null);
          setCurrentStepIndex(0);
        });
      }
      return next;
    });
    setConflictPatientId(null);
  };

  const markRemoteDeleteConflict = useCallback((patientId) => {
    if (!patientId) return;
    setPatients(prev => prev.map(p => (
      p.id === patientId
        ? {
            ...p,
            sync: {
              ...(p.sync || {}),
              syncStatus: 'conflict',
              conflict: {
                ...(p.sync?.conflict || {}),
                kind: 'remote-delete',
                serverRevision: null,
              },
            },
          }
        : p
    )));
  }, [setPatients]);

  // 서버의 잘못된 생년월일을 로컬 값으로 정정한다.
  //
  // 기존 'use-local' 경로를 재사용하면 안 된다 — applyLocalVersion이 syncStatus를
  // 'dirty'로 되돌려 재-push를 유발하고, 그 push는 서버의 안전장치에 다시 409로 막힌다.
  // 정정 API가 돌려준 최신 서버 환자로 교체해 새 revision과 'synced'를 그대로 반영한다.
  const handleCorrectServerIdentity = useCallback(async ({ patient, birthDate, reasonCode }) => {
    if (!patient || !birthDate) return;

    const ok = await showConfirm(
      `서버에 저장된 생년월일을 '${birthDate}'로 정정합니다.\n`
      + `같은 등록번호를 쓰는 다른 평가 건이 있으면 함께 갱신됩니다.\n\n`
      + `이 등록번호가 정말 이 환자의 것인지 확인하셨나요?`
    );
    if (!ok) return;

    try {
      const { patient: corrected, affectedPatientIds } = await correctPatientIdentity(patient, {
        birthDate, reasonCode, session, settings,
      });

      // 서버 응답으로 통째 교체 — dirty로 되돌리지 않는다.
      setPatients(prev => prev.map(p => (
        p.id === patient.id ? { ...corrected, id: patient.id, meta: p.meta ?? corrected.meta } : p
      )));
      setConflictPatientId(null);

      // 복수 case가 갱신됐으면 나머지 로컬 case의 revision이 뒤처진다.
      if (affectedPatientIds.length > 1) {
        await showAlert(
          `생년월일을 정정했습니다.\n같은 환자의 다른 평가 ${affectedPatientIds.length - 1}건도 함께 갱신되었으므로,\n`
          + `해당 건은 새로고침 후 편집하세요.`
        );
      }
    } catch (error) {
      const code = error?.data?.code;
      if (code === 'IDENTITY_CORRECTION_REQUIRES_ADMIN') {
        await showAlert('이 등록번호에는 여러 평가 건이 연결되어 있어 관리자만 정정할 수 있습니다.\n관리자에게 요청하세요.');
        return;
      }
      if (code === 'LOCK_HELD') {
        await showAlert(`다른 사용자가 관련 평가 건을 편집 중입니다.\n${error?.message || ''}`);
        return;
      }
      await showAlert(`생년월일 정정에 실패했습니다. ${error?.message || '다시 시도해 주세요.'}`);
    }
  }, [session, settings, setPatients, setConflictPatientId]);

  const handleResolveConflict = async (resolution, { patient, serverPatient, mergedData } = {}) => {
    if (!patient) return;
    const conflict = patient.sync?.conflict || {};
    const conflictKind = conflict.kind;

    if (resolution === 'use-local' && conflictKind === 'delete') {
      try {
        await deletePatientOnServer(
          patient.sync.serverId,
          serverPatient?.sync?.revision ?? conflict.serverRevision ?? patient.sync.revision,
          { session, settings }
        );
        applyResolvedConflict(patient.id, resolution, { serverPatient });
      } catch (error) {
        if (error?.status === 404) {
          applyResolvedConflict(patient.id, resolution, { serverPatient });
          return;
        }
        setPatients(prev => prev.map(p => (
          p.id === patient.id
            ? {
                ...p,
                sync: {
                  ...(p.sync || {}),
                  syncStatus: 'conflict',
                  conflict: {
                    ...(p.sync?.conflict || {}),
                    serverRevision: error?.data?.currentRevision ?? p.sync?.conflict?.serverRevision ?? null,
                  },
                },
              }
            : p
        )));
        await showAlert(`Delete failed. ${error?.message || 'Please try again.'}`);
      }
      return;
    }

    const needsNewLocalId = conflictKind === 'remote-delete' && (
      resolution === 'use-local' || resolution === 'merge'
    );
    applyResolvedConflict(patient.id, resolution, {
      serverPatient,
      mergedData,
      newId: needsNewLocalId ? crypto.randomUUID() : null,
    });
  };

  return {
    applyResolvedConflict,
    markRemoteDeleteConflict,
    handleResolveConflict,
    handleCorrectServerIdentity,
  };
}
