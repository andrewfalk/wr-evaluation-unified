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

// 정정 버튼은 (a) 생년월일 불일치 충돌이고 (b) 서버에 기존 기록이 있을 때만 의미가 있다.
// - PATIENT_PERSON_CONFLICT는 생년월일 문제가 아니라 등록번호 중복이므로 제외.
// - serverId가 없는 최초 POST 충돌은 서버 값을 조회조차 못 해(아래 useEffect가 skip)
//   사용자에게 비교 근거를 줄 수 없으므로 제외. 그 경우는 마이그레이션으로 해소된다.
export function canShowCorrectServerButton(patient) {
  return patient?.sync?.conflict?.code === 'PATIENT_IDENTITY_CONFLICT'
    && Boolean(patient?.sync?.serverId);
}

export function getBirthDate(patient) {
  return patient?.data?.shared?.birthDate || '';
}

const REASON_CODE = 'batch_import_typo';

function getPatientLabel(patient) {
  const shared = patient?.data?.shared || {};
  return shared.name || shared.patientNo || patient?.id || '-';
}

export function PatientIdentityConflictModal({
  patient,
  session,
  settings,
  onUseServer,
  onCorrectServer,
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

  const localBirthDate  = getBirthDate(patient);
  const serverBirthDate = getBirthDate(serverPatient);
  const canCorrect = canShowCorrectServerButton(patient);
  // 정정할 값이 있어야(로컬 생년월일 비어있지 않음) 의미가 있다 — 서버는 빈 값을 거부한다.
  const correctDisabled = useServerDisabled || !localBirthDate;

  const handleCorrectServer = () => {
    if (!serverPatient || !localBirthDate) return;
    onCorrectServer?.({ serverPatient, birthDate: localBirthDate, reasonCode: REASON_CODE });
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

        {canCorrect && serverPatient && (
          <div className="conflict-notice">
            <p className="modal-section-description">어느 쪽 생년월일이 맞는지 확인하세요.</p>
            <ul className="import-reference-list">
              <li>서버에 저장된 값: <strong>{serverBirthDate || '(없음)'}</strong></li>
              <li>내가 입력한 값: <strong>{localBirthDate || '(없음)'}</strong></li>
            </ul>
          </div>
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
          {canCorrect && (
            <button
              className="btn btn-warning"
              onClick={handleCorrectServer}
              disabled={correctDisabled}
            >
              내 값이 맞음 — 서버 기록 정정
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
