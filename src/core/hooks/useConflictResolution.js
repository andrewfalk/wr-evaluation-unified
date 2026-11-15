// @ts-nocheck
import { useCallback } from 'react';
import { correctPatientIdentity, deletePatientOnServer } from '../services/patientServerRepository';
import { getLockToken } from '../services/lockTokenStore';
import { showAlert, showConfirm } from '../utils/platform';
import { useGuardedDialogs } from '../../app/useWorkspaceLifetime';
import { patientTx } from '../state/patientStore/transitions';

// 환자 동기화 충돌 해결 핸들러
export function useConflictResolution({
  setPatients, activeId, setCurrentStepIndex,
  session, settings, setConflictPatientId, syncNow,
  dirtyAssessmentPatientId, onBlockedByUnsavedDraft,
}) {
  // 화면 수명(계정 전환 수정 AS-4) — 화면이 내려간 뒤에는 기다리던 처리의 서버 요청·파일·알림·확인창을 이어 가지 않는다.
  const { isAlive, alertAlive, confirmAlive } = useGuardedDialogs(showAlert, showConfirm);
  // 지금 종합소견을 편집 중인 환자를 충돌 해결/생년월일 정정으로 교체·삭제하면 draft가
  // 어느 데이터를 기준으로 저장될지 불명확해진다 — 편집 완료/취소로 먼저 마무리하게 한다.
  // useCallback으로 고정해 handleCorrectServerIdentity의 deps에 안전하게 넣는다.
  const isDirtyBlocked = useCallback((patientId) => {
    if (dirtyAssessmentPatientId && dirtyAssessmentPatientId === patientId) {
      onBlockedByUnsavedDraft?.();
      return true;
    }
    return false;
  }, [dirtyAssessmentPatientId, onBlockedByUnsavedDraft]);

  const applyResolvedConflict = (patientId, resolution, options = {}) => {
    if (isDirtyBlocked(patientId)) return;
    // 활성 환자 폴백은 전이의 derive가 같은 적용 안에서 정한다(P2-40c — 옮기기 전 updater 안 queueMicrotask 예약을 대체).
    // 판정은 옮기기 전처럼 **이 처리를 시작한 시점의 activeId**로 한다(D4 보존 — 검토 후보). 폴백했는지는 receipt로
    // dispatch 다음 줄에서 읽어 스텝을 처음으로 되돌린다(폴백 때 스텝 초기화 — 옮기기 전과 같음).
    const receipt = {};
    setPatients(patientTx.conflictResolved({ patientId, resolution, options, activeIdAtStart: activeId, receipt }));
    if (receipt.activeChanged) setCurrentStepIndex(0);
    setConflictPatientId(null);
  };

  const markRemoteDeleteConflict = useCallback((patientId) => {
    if (!patientId) return;
    setPatients(patientTx.remoteDeleteMarked({ id: patientId }));
  }, [setPatients]);

  // 서버의 잘못된 생년월일을 로컬 값으로 정정한다.
  //
  // 기존 'use-local' 경로를 재사용하면 안 된다 — applyLocalVersion이 syncStatus를
  // 'dirty'로 되돌려 재-push를 유발하고, 그 push는 서버의 안전장치에 다시 409로 막힌다.
  // 정정 API가 돌려준 최신 서버 환자로 교체해 새 revision과 'synced'를 그대로 반영한다.
  const handleCorrectServerIdentity = useCallback(async ({ patient, birthDate, reasonCode }) => {
    if (!patient || !birthDate) return;
    if (isDirtyBlocked(patient.id)) return;

    const ok = await confirmAlive(
      `서버에 저장된 생년월일을 '${birthDate}'로 정정합니다.\n`
      + `같은 등록번호를 쓰는 다른 평가 건이 있으면 함께 갱신됩니다.\n\n`
      + `이 등록번호가 정말 이 환자의 것인지 확인하셨나요?`
    );
    if (!ok) return;

    try {
      const { patient: corrected, affectedPatientIds } = await correctPatientIdentity(patient, {
        birthDate, reasonCode, session, settings,
        // enforce 모드에서는 본인이 들고 있는 lease token을 같이 보내야 통과한다.
        // 편집 중 충돌을 만나 정정하는 것이 가장 흔한 경로이므로 이게 없으면 정상 사용자가
        // 자기 락 때문에 423으로 막힌다.
        leaseToken: getLockToken(patient.id),
      });

      // 서버 응답으로 통째 교체 — dirty로 되돌리지 않는다.
      setPatients(patientTx.replacedFromServer({ id: patient.id, serverPatient: corrected, keepLocalMeta: true }));
      setConflictPatientId(null);

      // 복수 case가 갱신됐으면 나머지 로컬 case의 revision이 뒤처진다.
      // 알림만 띄우고 끝내면 그 case들은 구 revision을 들고 있다가 다음 저장에서 409가 난다.
      // 실제로 pull을 돌려 최신 revision을 받아온다.
      if (affectedPatientIds.length > 1) {
        if (!isAlive()) return;
        await syncNow?.({ pull: true, reason: 'identity-correction' });
        await alertAlive(
          `생년월일을 정정했습니다.\n`
          + `같은 환자의 다른 평가 ${affectedPatientIds.length - 1}건도 함께 갱신되어 최신 상태로 동기화했습니다.`
        );
      }
    } catch (error) {
      const code = error?.data?.code;
      if (code === 'IDENTITY_CORRECTION_REQUIRES_ADMIN') {
        await alertAlive('이 등록번호에는 여러 평가 건이 연결되어 있어 관리자만 정정할 수 있습니다.\n관리자에게 요청하세요.');
        return;
      }
      if (code === 'LOCK_HELD') {
        await alertAlive(`다른 사용자가 관련 평가 건을 편집 중입니다.\n${error?.message || ''}`);
        return;
      }
      await alertAlive(`생년월일 정정에 실패했습니다. ${error?.message || '다시 시도해 주세요.'}`);
    }
  }, [session, settings, setPatients, setConflictPatientId, syncNow, isDirtyBlocked, isAlive, alertAlive, confirmAlive]);

  const handleResolveConflict = async (resolution, { patient, serverPatient, mergedData } = {}) => {
    if (!patient) return;
    if (isDirtyBlocked(patient.id)) return;
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
        setPatients(patientTx.deleteRevisionUpdated({ id: patient.id, currentRevision: error?.data?.currentRevision }));
        await alertAlive(`Delete failed. ${error?.message || 'Please try again.'}`);
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
