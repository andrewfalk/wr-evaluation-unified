import { useEffect, useState } from 'react';
import { fetchPatient } from '../services/patientServerRepository';

const MESSAGES = {
  PATIENT_IDENTITY_CONFLICT:
    '이 등록번호는 같은 조직의 다른 환자(생년월일 상이)에게 이미 등록돼 있습니다. 등록번호 또는 생년월일을 다시 확인하세요.',
  PATIENT_PERSON_CONFLICT:
    '이 등록번호의 환자가 이미 조직에 등록돼 있습니다. 등록번호를 다시 확인하세요.',
};

export function getIdentityConflictMessage(code) {
  return MESSAGES[code] || '서버 측에서 등록번호 충돌이 감지되었습니다. 등록번호를 다시 확인하세요.';
}

export function canShowUseServerButton(patient) {
  return Boolean(patient?.sync?.serverId);
}

export function isUseServerActionDisabled({ serverPatient, loading, fetchError }) {
  return !serverPatient || Boolean(loading) || Boolean(fetchError);
}

function getPatientLabel(patient) {
  const shared = patient?.data?.shared || {};
  return shared.name || shared.patientNo || patient?.id || '-';
}

export function PatientIdentityConflictModal({
  patient,
  session,
  settings,
  onUseServer,
  onEditIdentity,
  onClose,
}) {
  const conflict = patient?.sync?.conflict || {};
  const code = conflict.code;
  const serverId = patient?.sync?.serverId || null;

  const [serverPatient, setServerPatient] = useState(null);
  const [loading, setLoading] = useState(false);
  const [fetchError, setFetchError] = useState('');

  useEffect(() => {
    if (!serverId) return undefined;

    let cancelled = false;
    setLoading(true);
    setFetchError('');
    fetchPatient(serverId, { session, settings })
      .then(next => {
        if (!cancelled) setServerPatient(next);
      })
      .catch(error => {
        if (!cancelled) {
          setFetchError(error?.message || '서버 버전을 불러오지 못했습니다.');
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [serverId, session, settings]);

  if (!patient) return null;

  const canUseServer = canShowUseServerButton(patient);
  const useServerDisabled = isUseServerActionDisabled({ serverPatient, loading, fetchError });

  const handleUseServer = () => {
    if (!serverPatient) return;
    onUseServer?.(serverPatient);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal conflict-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>등록번호 충돌</h2>
            <p className="modal-section-description">
              {getPatientLabel(patient)} · {code || 'identity-conflict'}
            </p>
          </div>
        </div>

        <p className="conflict-notice conflict-notice-warning">{getIdentityConflictMessage(code)}</p>

        {canUseServer && loading && (
          <div className="conflict-notice">서버 버전을 불러오는 중...</div>
        )}
        {canUseServer && fetchError && (
          <div className="conflict-notice conflict-notice-warning">{fetchError}</div>
        )}

        <div className="modal-actions conflict-actions">
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
          <button className="btn btn-info" onClick={onEditIdentity}>등록번호 다시 입력</button>
          {canUseServer && (
            <button
              className="btn btn-primary"
              onClick={handleUseServer}
              disabled={useServerDisabled}
            >
              서버 값으로 되돌리기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
