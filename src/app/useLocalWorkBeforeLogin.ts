// 로그인 직전 로컬 작업 보존(계정 전환 수정 AS-4, 설계 판단 J2·설계 6).
//
// 로컬 작업을 두고 로그인하면 화면은 새로 시작된다(이전 로컬 목록이 로그인한 계정 이름으로 서버에 올라가지 않게). 대신 로그인을
// 적용하기 직전에 화면의 로컬 목록을 로컬 자동저장에 써 둔다 — 자동저장 복원은 저장본을 지우므로, 이것이 없으면 유일한 사본이
// 사라질 수 있다. 다음에 로컬 모드로 들어가면 복원 안내가 뜬다.
//  - 판정: 작업 공간 주인이 없고(= 화면의 목록이 로컬 작업) 환자가 1명 이상이면 쓴다. 주인이 있으면(이전 인트라넷 계정의 목록)
//    쓰지 않는다 — 다른 계정의 서버 환자를 로컬 저장소에 남기지 않는다.
//  - 저수준 로컬 저장(storage.js saveAutoSave)을 직접 부른다 — saveAutoSavedWorkspace는 문맥이 인트라넷이면 쓰지 않는다.
//    Electron 독립형은 파일 저장이 끝날 때까지 기다린다. 실패하면 던진다(로그인 화면이 알리고 로그인하지 않는다).
//  - 돌려주는 함수는 고정 참조이고, 불리는 시점의 최신 목록·주인을 읽는다(로그인 화면의 비동기 제출은 제출 당시 클로저를 쥔다).
//    목록 ref는 커밋 중(layout effect)에 갱신한다 — 복원본 삭제(useWorkspacePersistence의 passive effect)보다 먼저라서
//    "저장본이 지워졌다 ⇒ 이 함수가 그 목록을 본다"가 성립한다.
import { useCallback, useLayoutEffect, useRef } from 'react';
import { saveAutoSave as saveAutoSaveJs } from '../core/utils/storage';

export interface LocalWorkBeforeLoginArgs {
  patients: unknown[];
  getWorkspaceOwner: () => string | null;
}

function saveAutoSave(patients: unknown[]): Promise<void> {
  return (saveAutoSaveJs as unknown as (p: unknown[]) => Promise<void>)(patients);
}

export function useLocalWorkBeforeLogin({ patients, getWorkspaceOwner }: LocalWorkBeforeLoginArgs): () => Promise<void> {
  const latestRef = useRef<{ patients: unknown[]; getWorkspaceOwner: () => string | null }>({ patients, getWorkspaceOwner });
  useLayoutEffect(() => {
    latestRef.current = { patients, getWorkspaceOwner };
  }, [patients, getWorkspaceOwner]);
  return useCallback(async () => {
    const { patients: list, getWorkspaceOwner: ownerOf } = latestRef.current;
    if (ownerOf() !== null) return;
    if (!Array.isArray(list) || list.length === 0) return;
    await saveAutoSave(list);
  }, []);
}
