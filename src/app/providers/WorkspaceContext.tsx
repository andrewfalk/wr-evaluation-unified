// 작업 공간 Context(REFACTORING_ROADMAP Phase 2 C3-C, P2-45a) — App이 컨트롤러 1~7을 불러 얻은 값 묶음을 화면·모달에 내린다.
//
// - **1개**만 둔다(계획 C8): React 18.3.1은 Provider 값이 바뀔 때마다 그 아래 fiber를 훑는다(enableLazyContextPropagation=false) —
//   비용이 Context 개수에 비례. App과 소비자 사이에 memo 경계가 없어 추가 렌더·commit은 없다(지금도 App 렌더마다 전부 다시 그린다).
// - 값은 매 렌더 새 객체(컨트롤러 반환을 펼친 것). 소비자는 필드를 꺼내 쓰고, 훅이 준 참조는 그대로다(계획 원칙 3).
// - 이 Context는 `src/app/**`만 만들고 읽는다. core 컴포넌트는 지금처럼 props로 받는다(계획 원칙 5). 훅은 Context를 읽지 않는다(원칙 1).
// - Provider는 값만 전달하고 훅을 부르지 않는다. 소비는 useWorkspace()로 감싸 나중에 쪼갤 수 있게 한다.
import { createContext, useContext, type ReactNode } from 'react';
import type { WorkspaceValue } from '../workspace/workspaceValue';

const WorkspaceContext = createContext<WorkspaceValue | null>(null);

export function WorkspaceProvider({ value, children }: { value: WorkspaceValue; children: ReactNode }) {
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/** 작업 공간 값 — WorkspaceProvider 아래에서만. */
export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace must be used within a WorkspaceProvider');
  return value;
}
