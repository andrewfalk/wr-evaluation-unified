// 종합소견 미저장 초안 가드 — REFACTORING_ROADMAP Phase 2 C3-A(P2-29). App.jsx에 흩어져 있던 ① 초안 상태(환자 ID)
// ② 막힘 안내 ③ 편집 진입/종료 신호 ④ 화면을 떠나는 동작 앞의 가드(6곳이 같은 두 줄을 반복) ⑤ 셸 신호(창 닫기 확인)
// ⑥ 웹·독립형 beforeunload를 한 곳으로. 동작은 그대로다.
//
// C4(P2-43)에서 액션 meta.leavesDraft 미들웨어로 옮길 예정 — 그때까지는 화면 동작마다 blockIfDraftDirty()를 부른다.
import { useCallback, useEffect, useState } from 'react';
import { showAlert } from '../platform/dialogs';
import { getLifecycleBridge } from '../platform/bridge';
import { detectRuntime } from '../platform/runtime';

export const UNSAVED_DRAFT_MESSAGE = '저장하지 않은 종합소견 편집 내용이 있습니다.\n"편집 완료" 또는 "취소"로 마무리한 뒤 다시 시도하세요.';

export interface UnsavedDraftGuard {
  /** 편집 중인 환자 ID(불리언이 아님 — 환자를 바꿔도 dirty가 잘못 따라붙지 않게, AssessmentStep이 patient prop만 바뀌는 구조). */
  dirtyAssessmentPatientId: string | null;
  /** 막힘 안내(alert). 하위 훅에 onBlockedByUnsavedDraft로 넘긴다. */
  blockedByUnsavedDraftAlert: () => void;
  /** AssessmentStep의 편집 진입/종료 신호. 종료(false)는 그 환자가 지금 dirty일 때만 지운다(낡은 신호 방지). */
  handleAssessmentEditingChange: (patientId: string, isEditing: boolean) => void;
  /** 화면을 떠나는 동작 앞에서: 초안이 있으면 안내하고 true(호출부는 멈춘다), 없으면 false. */
  blockIfDraftDirty: () => boolean;
}

export function useUnsavedDraftGuard(): UnsavedDraftGuard {
  const [dirtyAssessmentPatientId, setDirtyAssessmentPatientId] = useState<string | null>(null);

  const blockedByUnsavedDraftAlert = useCallback(() => {
    showAlert(UNSAVED_DRAFT_MESSAGE);
  }, []);

  const handleAssessmentEditingChange = useCallback((patientId: string, isEditing: boolean) => {
    setDirtyAssessmentPatientId((prev) => {
      if (isEditing) return patientId;
      return prev === patientId ? null : prev;
    });
  }, []);

  const blockIfDraftDirty = useCallback(() => {
    if (!dirtyAssessmentPatientId) return false;
    blockedByUnsavedDraftAlert();
    return true;
  }, [dirtyAssessmentPatientId, blockedByUnsavedDraftAlert]);

  // 셸에 초안 여부를 알린다 — 인트라넷 셸은 창 닫기(win.on('close'))·메뉴 새로고침(Ctrl+R)에서 이 값으로 네이티브 확인을
  // 띄운다. PHI(환자 ID)는 넘기지 않고 boolean만. 채널이 없는 빌드(독립형·웹)에서는 조용히 no-op.
  useEffect(() => {
    getLifecycleBridge()?.setHasUnsavedDraft?.(!!dirtyAssessmentPatientId);
  }, [dirtyAssessmentPatientId]);

  // 웹 탭 닫기·새로고침 경고 — 셸이 창 닫기를 가로채면(인트라넷 셸 setHasUnsavedDraft — 구 셸 포함, 키로 판정) 등록하지
  // 않는다: 그 네이티브 확인에서 "계속"을 골라도 남은 beforeunload가 다시 개입해 종료가 조용히 취소되거나 확인이 두 번 뜰
  // 수 있다. 독립형은 창 닫기 가로채기가 없어 beforeunload가 유일한 안전망.
  useEffect(() => {
    if (detectRuntime().hasNativeCloseGuard) return undefined;
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirtyAssessmentPatientId) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [dirtyAssessmentPatientId]);

  return { dirtyAssessmentPatientId, blockedByUnsavedDraftAlert, handleAssessmentEditingChange, blockIfDraftDirty };
}
