// 모달 열림 상태 — REFACTORING_ROADMAP Phase 2 C3-A(P2-30). App.jsx의 모달 불리언 8개와 usePresetManagement의 프리셋 모달
// 3칸을 **키별 맵 하나**로 모은다. 단일 슬롯(`modal: {name, payload}`)이 아니라 키별인 이유: 모달들이 서로 독립 조건이라
// 동시에 열릴 수 있다(계획 F4 — 예: 프리셋 조회 → 관리 전환 중 두 칸이 함께 차 있음, 충돌 해결 모달 + 다른 모달).
// 단일 슬롯으로 바꾸면 동작이 바뀐다. 모달은 src/app/modals/ModalHost.tsx가 작업 공간 Context로 받는다(C3-C P2-45a).
import { useCallback, useMemo, useState, type Dispatch, type SetStateAction } from 'react';

export interface ModalSlots {
  save: boolean;
  load: boolean;
  settings: boolean;
  adminConsole: boolean;
  accountProfile: boolean;
  changePassword: boolean;
  migrationReport: boolean;
  batchImport: boolean;
  /** 프리셋 저장(관리) 모달 — 대상 직력 id. null이면 닫힘. */
  presetManageJobId: string | null;
  /** 프리셋 관리 모달에서 고치는 중인 프리셋(조회 모달에서 "수정"으로 넘어온 경우). */
  presetEditingPreset: unknown;
  /** 프리셋 조회 모달 — 대상 직력 id. null이면 닫힘. */
  presetBrowseJobId: string | null;
}

export type ModalKey = keyof ModalSlots;

export const INITIAL_MODAL_SLOTS: ModalSlots = {
  save: false,
  load: false,
  settings: false,
  adminConsole: false,
  accountProfile: false,
  changePassword: false,
  migrationReport: false,
  batchImport: false,
  presetManageJobId: null,
  presetEditingPreset: null,
  presetBrowseJobId: null,
};

export type SlotSetter<K extends ModalKey> = (value: SetStateAction<ModalSlots[K]>) => void;

export interface ModalState {
  modals: ModalSlots;
  /** useState setter와 같은 의미(값 또는 이전 값 → 새 값). 같은 값이면 상태를 바꾸지 않는다(재렌더 없음 — 예전 개별 useState와 같음). */
  setModal: <K extends ModalKey>(key: K, value: SetStateAction<ModalSlots[K]>) => void;
  /** 키 하나의 setter(안정된 참조) — 예전 setShowXxx·setPresetXxx 자리에 그대로 넘긴다. */
  setterFor: <K extends ModalKey>(key: K) => SlotSetter<K>;
  /**
   * 관리자 콘솔을 열 탭(P2-83e) — 운영 경고 배너가 'ops'로 정하고 콘솔을 연다. null이면 콘솔의 기본 탭(감사 로그).
   * 콘솔을 닫을 때 null로 되돌린다(ModalHost) — 배너로 연 뒤 닫고 계정 메뉴로 다시 열면 기본 탭이다.
   */
  adminConsoleTab: string | null;
  setAdminConsoleTab: Dispatch<SetStateAction<string | null>>;
}

export function useModalState(): ModalState {
  const [modals, setModals] = useState<ModalSlots>(INITIAL_MODAL_SLOTS);
  const [adminConsoleTab, setAdminConsoleTab] = useState<string | null>(null);

  const setModal = useCallback(<K extends ModalKey>(key: K, value: SetStateAction<ModalSlots[K]>) => {
    setModals((prev) => {
      const next = typeof value === 'function'
        ? (value as (p: ModalSlots[K]) => ModalSlots[K])(prev[key])
        : value;
      return Object.is(prev[key], next) ? prev : { ...prev, [key]: next };
    });
  }, []);

  // 키별 setter를 한 번만 만들어 참조를 고정한다(의존성 배열에 넣은 하위 훅의 effect가 다시 돌지 않게).
  const setters = useMemo(() => {
    const out = {} as { [K in ModalKey]: SlotSetter<K> };
    for (const key of Object.keys(INITIAL_MODAL_SLOTS) as ModalKey[]) {
      (out as Record<ModalKey, SlotSetter<ModalKey>>)[key] = (value) => setModal(key, value);
    }
    return out;
  }, [setModal]);

  const setterFor = useCallback(<K extends ModalKey>(key: K) => setters[key] as SlotSetter<K>, [setters]);

  return { modals, setModal, setterFor, adminConsoleTab, setAdminConsoleTab };
}
