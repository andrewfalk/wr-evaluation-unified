import { useCallback, useState } from 'react';
import {
  migrateToServer,
  runMigration,
  MigrationCanceledError,
} from '../services/localToServerMigrator';

// Hook wrapping the local-to-server migration.
// session and settings must come from the caller (same pattern as usePatientSync).
//
// status: 'idle' | 'running' | 'done' | 'error'
// result: null | { migrated, failed, alreadySynced } | { error }
export function useMigration({ session, settings } = {}) {
  const [status, setStatus] = useState('idle');
  const [result, setResult] = useState(null);

  const start = useCallback(async () => {
    if (status === 'running') return;
    setStatus('running');
    setResult(null);
    try {
      const r = await runMigration({ session, settings });
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
  }, [session, settings, status]);

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
