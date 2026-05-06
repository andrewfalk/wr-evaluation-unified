import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  mergePulledPatients,
  mergeServerPatient,
  pullPatients,
  pushPendingPatients,
} from '../services/patientServerRepository';

const SYNC_INTERVAL_MS = 5 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;
const PULL_PAGE_SIZE = 100;

function hasPendingPatients(patients = []) {
  return patients.some(p => {
    const status = p?.sync?.syncStatus;
    return status === 'local-only' || status === 'dirty';
  });
}

function applySyncedPatients(localPatients, syncedPatients) {
  return syncedPatients.reduce(
    (next, serverPatient) => mergeServerPatient(next, serverPatient),
    localPatients
  );
}

function buildPushConflict(failure) {
  const data = failure?.error?.data || {};
  return {
    kind: 'push',
    code: data.code || null,
    message: failure?.error?.message || data.error || null,
    serverRevision: data.currentRevision ?? null,
  };
}

function applyPushFailures(localPatients, failures) {
  const conflictById = new Map(
    failures
      .filter(f => f.kind === 'conflict' && f.patient?.id)
      .map(f => [f.patient.id, buildPushConflict(f)])
  );

  if (conflictById.size === 0) return localPatients;

  return localPatients.map(patient => {
    const conflict = conflictById.get(patient.id);
    if (!conflict) return patient;
    return {
      ...patient,
      sync: {
        ...(patient.sync || {}),
        syncStatus: 'conflict',
        conflict,
      },
    };
  });
}

export function reconcilePulledPatients(localPatients, pulledItems) {
  const pulledServerIds = new Set(
    pulledItems
      .map(patient => patient?.sync?.serverId || patient?.id)
      .filter(Boolean)
  );

  const merged = mergePulledPatients(localPatients, pulledItems);

  return merged
    .map(patient => {
      const serverId = patient?.sync?.serverId;
      if (!serverId || pulledServerIds.has(serverId)) return patient;

      if (patient.sync?.syncStatus === 'dirty') {
        return {
          ...patient,
          sync: {
            ...(patient.sync || {}),
            syncStatus: 'conflict',
            conflict: {
              ...(patient.sync?.conflict || {}),
              kind: 'remote-delete',
              serverRevision: null,
            },
          },
        };
      }

      return patient;
    })
    .filter(patient => {
      const serverId = patient?.sync?.serverId;
      if (!serverId || pulledServerIds.has(serverId)) return true;
      return patient.sync?.syncStatus !== 'synced';
    });
}

async function pullAllPatients({ session, settings }) {
  const all = [];
  let offset = 0;
  let total = null;

  do {
    const result = await pullPatients({
      session,
      settings,
      params: { limit: PULL_PAGE_SIZE, offset },
    });
    const items = result.items || [];
    all.push(...items);
    total = typeof result.total === 'number' ? result.total : all.length;
    offset += items.length;
    if (items.length === 0) break;
  } while (all.length < total);

  return all;
}

export function usePatientSync({
  patients,
  setPatients,
  activeId,
  setActiveId,
  session,
  settings,
  enabled = true,
} = {}) {
  const [syncState, setSyncState] = useState({
    status: 'idle',
    lastSyncedAt: null,
    lastError: null,
  });

  const patientsRef = useRef(patients || []);
  const activeIdRef = useRef(activeId || null);
  const sessionRef = useRef(session || null);
  const settingsRef = useRef(settings || null);
  const enabledRef = useRef(false);
  const inFlightRef = useRef(false);
  const queuedRef = useRef(null);

  const canSync = useMemo(() => (
    enabled &&
    session?.mode === 'intranet' &&
    !!session?.user?.id &&
    !!session?.accessToken
  ), [
    enabled,
    session?.mode,
    session?.user?.id,
    session?.accessToken,
  ]);

  useEffect(() => { patientsRef.current = patients || []; }, [patients]);
  useEffect(() => { activeIdRef.current = activeId || null; }, [activeId]);
  useEffect(() => { sessionRef.current = session || null; }, [session]);
  useEffect(() => { settingsRef.current = settings || null; }, [settings]);
  useEffect(() => { enabledRef.current = canSync; }, [canSync]);

  const ensureActivePatient = useCallback((before, after) => {
    if (activeIdRef.current || before.length > 0 || after.length === 0 || !setActiveId) {
      return;
    }
    queueMicrotask(() => {
      if (!activeIdRef.current) setActiveId(after[0].id);
    });
  }, [setActiveId]);

  const runSync = useCallback(async ({
    push = false,
    pull = false,
    reason = 'manual',
  } = {}) => {
    if (!enabledRef.current) return null;

    if (inFlightRef.current) {
      queuedRef.current = {
        push: Boolean(queuedRef.current?.push || push),
        pull: Boolean(queuedRef.current?.pull || pull),
        reason,
      };
      return null;
    }

    inFlightRef.current = true;
    setSyncState(prev => ({ ...prev, status: 'syncing', lastError: null }));

    try {
      if (push) {
        const snapshot = patientsRef.current;
        if (hasPendingPatients(snapshot)) {
          const { synced, failed } = await pushPendingPatients(snapshot, {
            session: sessionRef.current,
            settings: settingsRef.current,
          });

          if (synced.length > 0 || failed.some(f => f.kind === 'conflict')) {
            setPatients(prev => {
              const withSynced = applySyncedPatients(prev, synced);
              return applyPushFailures(withSynced, failed);
            });
          }

          const nonConflictFailure = failed.find(f => f.kind !== 'conflict');
          if (nonConflictFailure) throw nonConflictFailure.error;
        }
      }

      if (pull) {
        const pulledItems = await pullAllPatients({
          session: sessionRef.current,
          settings: settingsRef.current,
        });
        setPatients(prev => {
          const next = reconcilePulledPatients(prev, pulledItems);
          ensureActivePatient(prev, next);
          if (activeIdRef.current && !next.some(p => p.id === activeIdRef.current)) {
            queueMicrotask(() => {
              if (activeIdRef.current && !next.some(p => p.id === activeIdRef.current)) {
                setActiveId?.(next[0]?.id || null);
              }
            });
          }
          return next;
        });
      }

      const lastSyncedAt = new Date().toISOString();
      setSyncState({ status: 'idle', lastSyncedAt, lastError: null });
      return { ok: true, reason, lastSyncedAt };
    } catch (error) {
      console.warn('[patient-sync]', reason, error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        lastError: error?.message || 'Patient sync failed',
      }));
      return { ok: false, reason, error };
    } finally {
      inFlightRef.current = false;
      const queued = queuedRef.current;
      queuedRef.current = null;
      if (queued && enabledRef.current) {
        queueMicrotask(() => { runSync(queued); });
      }
    }
  }, [ensureActivePatient, setActiveId, setPatients]);

  useEffect(() => {
    if (!canSync) return;
    runSync({ push: true, pull: true, reason: 'startup' });
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync) return;
    const timer = window.setInterval(() => {
      runSync({ push: true, pull: true, reason: 'interval' });
    }, SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync) return;

    const onFocus = () => {
      runSync({ pull: true, reason: 'focus' });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        runSync({ pull: true, reason: 'visible' });
      }
    };

    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [canSync, runSync]);

  useEffect(() => {
    if (!canSync || !hasPendingPatients(patients || [])) return;
    const timer = window.setTimeout(() => {
      runSync({ push: true, reason: 'local-change' });
    }, PUSH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [canSync, patients, runSync]);

  return {
    syncState,
    syncNow: runSync,
  };
}
