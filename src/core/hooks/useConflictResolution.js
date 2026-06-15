import { useCallback } from 'react';
import { resolvePatientConflictInList } from '../services/patientConflictResolution';
import { deletePatientOnServer } from '../services/patientServerRepository';
import { showAlert } from '../utils/platform';

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

  return { applyResolvedConflict, markRemoteDeleteConflict, handleResolveConflict };
}
