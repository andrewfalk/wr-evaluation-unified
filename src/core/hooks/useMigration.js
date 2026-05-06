import { useCallback, useState } from 'react';
import { runMigration } from '../services/localToServerMigrator';

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
      setResult({ error: err });
      setStatus('error');
    }
  }, [session, settings, status]);

  const reset = useCallback(() => {
    setStatus('idle');
    setResult(null);
  }, []);

  return { status, result, start, reset };
}
