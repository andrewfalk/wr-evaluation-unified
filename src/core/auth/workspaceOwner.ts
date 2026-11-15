// 작업 공간 주인·세대(계정 전환 수정 AS-3). 화면(App)은 세대(epoch)를 key로 다시 띄워진다 — 세대가 오르면
// 이전 계정의 목록·선택·검색어·열린 창이 통째로 사라진다. 주인은 `정규화한 apiBaseUrl|user.id|organizationId`
// (역할은 넣지 않는다 — 역할이 바뀌어도 작업이 사라지면 안 된다). 전이는 이 순수 함수 하나로 두고 표 테스트로 고정한다.
import { intranetIdentityOf, normalizeBaseUrl } from '../../platform/dataMode';

export interface WorkspaceState {
  /** 화면의 목록이 누구의 작업인지 — null이면 로컬 작업(또는 빈 화면). */
  readonly owner: string | null;
  /** App의 key. 오르면 화면이 새로 시작된다. */
  readonly epoch: number;
}

export type WorkspaceEvent =
  /** login()으로 검증된 인트라넷 신원이 됨. */
  | { type: 'login'; owner: string }
  /** 부팅 때 저장된 세션이 검증됨(메모리는 비어 있다). */
  | { type: 'bootVerified'; owner: string }
  /** 명시적 로그아웃이 끝남. */
  | { type: 'logout' }
  /** 주인이 있는데 로컬 문맥이 됨(로컬 전환·서버 주소 변경). */
  | { type: 'discard' }
  /** 강제 로그아웃·다른 탭의 로그아웃·신원 거부로 로컬 세션이 됨 — 같은 사용자가 다시 로그인하면 이어 간다. */
  | { type: 'sessionReset' };

export const INITIAL_WORKSPACE: WorkspaceState = Object.freeze({ owner: null, epoch: 0 });

/** 작업 공간 주인 키 — 인트라넷 세션이 아니면 null. */
export function workspaceOwnerOf(session?: { mode?: string | null; apiBaseUrl?: string | null; user?: unknown } | null): string | null {
  const identity = intranetIdentityOf(session);
  if (identity === null) return null;
  return `${normalizeBaseUrl(session?.apiBaseUrl)}|${identity}`;
}

export function nextWorkspace(state: WorkspaceState, event: WorkspaceEvent): WorkspaceState {
  switch (event.type) {
    case 'login':
      // 만료 뒤 같은 사용자 → 작업을 이어 간다. 다른 사용자·로컬 작업(null) → 새로 시작(J2).
      return state.owner === event.owner ? state : { owner: event.owner, epoch: state.epoch + 1 };
    case 'bootVerified':
      return state.owner === event.owner ? state : { owner: event.owner, epoch: state.epoch };
    case 'logout':
      return { owner: null, epoch: state.epoch + 1 };
    case 'discard':
      // 주인이 없으면 로컬 사용자의 작업 — 보존한다.
      return state.owner === null ? state : { owner: null, epoch: state.epoch + 1 };
    case 'sessionReset':
      return state;
    default:
      return state;
  }
}
