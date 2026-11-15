// @ts-nocheck
import { useCallback, useState } from 'react';
import {
  migrateToServer,
  runMigration,
  MigrationCanceledError,
} from '../services/localToServerMigrator';
import { useWorkspaceLifetime } from '../../app/useWorkspaceLifetime';

// Hook wrapping the local-to-server migration.
// session and settings must come from the caller (same pattern as usePatientSync).
//
// status: 'idle' | 'running' | 'done' | 'error'
// result: null | { migrated, failed, alreadySynced } | { error }
export function useMigration({ session, settings } = {}) {
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);
  // 화면 수명(계정 전환 수정 AS-4) — 확인창을 기다리는 사이 화면이 내려갔으면 이관을 서버로 보내지 않는다.
  const { isAlive } = useWorkspaceLifetime();

  const start = useCallback(async () => {
    if (status === 'running') return;
    setStatus('running');
    setResult(null);
    try {
      const r = await runMigration({ session, settings, shouldProceed: isAlive });
      setResult(r);
      setStatus('done');
    } catch (err) {
      // User canceled the native confirm dialog — quietly return to idle.
      // Not an error to display in the modal.
      if (err instanceof MigrationCanceledError) {
        setStatus('idle');
        setResult(null);
        return;
      }
      setResult({ error: err });
      setStatus('error');
    }
  }, [session, settings, status, isAlive]);

  // Retry only the previously-failed patients without re-collecting from storage.
  // Merges new successes into the existing result so the total counts stay accurate.
  const retry = useCallback(async (failedPatients) => {
    if (status === 'running') return;
    setStatus('running');
    try {
      const r = await migrateToServer(failedPatients, { session, settings });
      setResult(prev => ({
        migrated:     [...(prev?.migrated     ?? []), ...r.migrated],
        alreadySynced:[...(prev?.alreadySynced ?? []), ...r.alreadySynced],
        failed:       r.failed,
        presetResult: prev?.presetResult,
      }));
      setStatus('done');
    } catch (err) {
      setResult(prev => ({ ...prev, error: err }));
      setStatus('error');
    }
  }, [session, settings, status]);

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
  }, []);

  return { status, result, start, retry, reset };
}
