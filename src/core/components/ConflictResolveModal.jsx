import { useEffect, useMemo, useRef, useState } from 'react';
import { fetchPatient } from '../services/patientServerRepository';

function getPatientLabel(patient) {
  const shared = patient?.data?.shared || {};
  return shared.name || shared.patientNo || patient?.id || '-';
}

function getSummary(patient) {
  const shared = patient?.data?.shared || {};
  return [
    ['Name', shared.name || '-'],
    ['No', shared.patientNo || '-'],
    ['Birth', shared.birthDate || '-'],
    ['Injury', shared.injuryDate || '-'],
    ['Evaluation', shared.evaluationDate || '-'],
    ['Revision', patient?.sync?.revision ?? '-'],
  ];
}

function buildInitialMergeData(localPatient, serverPatient) {
  if (!serverPatient?.data) return localPatient?.data || {};
  return {
    ...serverPatient.data,
    shared: {
      ...(serverPatient.data.shared || {}),
      ...(localPatient?.data?.shared || {}),
    },
    modules: {
      ...(serverPatient.data.modules || {}),
      ...(localPatient?.data?.modules || {}),
    },
    activeModules: localPatient?.data?.activeModules || serverPatient.data.activeModules || [],
  };
}

export function validateMergedPatientData(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'Merged data must be an object.';
  }
  if (!value.shared || typeof value.shared !== 'object' || Array.isArray(value.shared)) {
    return 'Merged data must include shared object.';
  }
  if (!value.modules || typeof value.modules !== 'object' || Array.isArray(value.modules)) {
    return 'Merged data must include modules object.';
  }
  if (!Array.isArray(value.activeModules) || value.activeModules.some(moduleId => typeof moduleId !== 'string')) {
    return 'Merged data must include activeModules string array.';
  }
  return '';
}

export function shouldWaitForMergeInitialization({ canFetchServer, serverPatient, serverError }) {
  return Boolean(canFetchServer && !serverPatient && !serverError);
}

export function getMergeInitializationKey(patient, conflictKind, serverId) {
  return [
    patient?.id || '',
    serverId || '',
    conflictKind || '',
    patient?.sync?.revision ?? '',
  ].join(':');
}

function SummaryPanel({ title, patient, emptyText }) {
  return (
    <section className="conflict-panel">
      <h3>{title}</h3>
      {patient ? (
        <dl className="conflict-summary">
          {getSummary(patient).map(([key, value]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="conflict-empty">{emptyText}</p>
      )}
    </section>
  );
}

export function ConflictResolveModal({
  patient,
  session,
  settings,
  onResolve,
  onClose,
}) {
  const conflict = patient?.sync?.conflict || {};
  const conflictKind = conflict.kind || 'pull';
  const [serverPatient, setServerPatient] = useState(conflict.serverPatient || null);
  const [loadingServer, setLoadingServer] = useState(false);
  const [serverError, setServerError] = useState('');
  const [mergeText, setMergeText] = useState('');
  const [mergeError, setMergeError] = useState('');
  const mergeTextInitializedRef = useRef({ key: null, initialized: false });

  const serverId = patient?.sync?.serverId;
  const canFetchServer = Boolean(
    !serverPatient &&
    serverId &&
    conflictKind !== 'remote-delete'
  );

  useEffect(() => {
    let cancelled = false;
    if (!canFetchServer) return () => { cancelled = true; };

    setLoadingServer(true);
    setServerError('');
    fetchPatient(serverId, { session, settings })
      .then(next => {
        if (!cancelled) setServerPatient(next);
      })
      .catch(error => {
        if (!cancelled) {
          if (error?.status === 404) {
            setServerError('Server version was deleted.');
          } else {
            setServerError(error?.message || 'Could not load server version.');
          }
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingServer(false);
      });

    return () => { cancelled = true; };
  }, [canFetchServer, serverId, session, settings]);

  const initialMergeData = useMemo(
    () => buildInitialMergeData(patient, serverPatient),
    [patient, serverPatient]
  );
  const mergeInitializationKey = getMergeInitializationKey(patient, conflictKind, serverId);

  useEffect(() => {
    if (mergeTextInitializedRef.current.key !== mergeInitializationKey) {
      mergeTextInitializedRef.current = { key: mergeInitializationKey, initialized: false };
      setMergeText('');
      setMergeError('');
    }
    if (mergeTextInitializedRef.current.initialized) return;
    if (shouldWaitForMergeInitialization({ canFetchServer, serverPatient, serverError })) return;

    setMergeText(JSON.stringify(initialMergeData, null, 2));
    setMergeError('');
    mergeTextInitializedRef.current.initialized = true;
  }, [canFetchServer, initialMergeData, mergeInitializationKey, serverError, serverPatient]);

  if (!patient) return null;

  const handleMerge = () => {
    try {
      const mergedData = JSON.parse(mergeText);
      const validationError = validateMergedPatientData(mergedData);
      if (validationError) {
        setMergeError(validationError);
        return;
      }
      setMergeError('');
      onResolve('merge', { patient, serverPatient, mergedData });
    } catch {
      setMergeError('Merged data must be valid JSON.');
    }
  };

  const handleUseLocal = () => {
    onResolve('use-local', { patient, serverPatient });
  };

  const handleUseServer = () => {
    onResolve('use-server', { patient, serverPatient });
  };

  const serverUnavailable = !serverPatient;
  const mergeInitializing = shouldWaitForMergeInitialization({ canFetchServer, serverPatient, serverError });
  const localLabel = conflictKind === 'delete' ? 'Apply Delete' : 'Use Local';
  const serverLabel = conflictKind === 'remote-delete' ? 'Accept Delete' : 'Use Server';

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal conflict-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>Resolve Conflict</h2>
            <p className="modal-section-description">
              {getPatientLabel(patient)} · {conflictKind}
            </p>
          </div>
          <span className="modal-section-badge">rev {patient.sync?.revision ?? '-'}</span>
        </div>

        {loadingServer && <div className="conflict-notice">Loading server version...</div>}
        {serverError && <div className="conflict-notice conflict-notice-warning">{serverError}</div>}

        <div className="conflict-grid">
          <SummaryPanel title="Local" patient={patient} emptyText="No local version" />
          <SummaryPanel title="Server" patient={serverPatient} emptyText="No server version" />
        </div>

        <section className="conflict-merge">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">Merge</h3>
            </div>
          </div>
          <textarea
            value={mergeText}
            onChange={e => setMergeText(e.target.value)}
            disabled={mergeInitializing}
            spellCheck="false"
          />
          {mergeError && <p className="login-modal-error">{mergeError}</p>}
        </section>

        <div className="modal-actions conflict-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-info" onClick={handleUseLocal}>{localLabel}</button>
          <button
            className="btn btn-primary"
            onClick={handleUseServer}
            disabled={serverUnavailable && conflictKind !== 'remote-delete'}
          >
            {serverLabel}
          </button>
          <button className="btn btn-primary" onClick={handleMerge} disabled={mergeInitializing}>Apply Merge</button>
        </div>
      </div>
    </div>
  );
}
