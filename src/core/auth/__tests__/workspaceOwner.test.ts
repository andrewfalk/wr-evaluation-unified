// 작업 공간 주인·세대 전이 표(계정 전환 수정 AS-3, R3의 순수 함수 부분).
import { describe, expect, it } from 'vitest';
import { INITIAL_WORKSPACE, nextWorkspace, workspaceOwnerOf, type WorkspaceEvent, type WorkspaceState } from '../workspaceOwner';

const A = 'https://srv|a|org-1';
const B = 'https://srv|b|org-1';

describe('workspaceOwnerOf', () => {
  it('정규화한 apiBaseUrl|user.id|organizationId — 역할은 넣지 않는다, 인트라넷 세션이 아니면 null', () => {
    expect(workspaceOwnerOf({ mode: 'intranet', apiBaseUrl: 'https://srv/ ', user: { id: 'a', organizationId: 'org-1', role: 'doctor' } })).toBe(A);
    expect(workspaceOwnerOf({ mode: 'intranet', apiBaseUrl: 'https://srv', user: { id: 'a', organizationId: 'org-1', role: 'admin' } })).toBe(A);
    expect(workspaceOwnerOf({ mode: 'local', user: { id: 'a', organizationId: 'org-1' } })).toBeNull();
    expect(workspaceOwnerOf(null)).toBeNull();
  });
});

describe('nextWorkspace — 전이 표', () => {
  const at = (owner: string | null, epoch: number): WorkspaceState => ({ owner, epoch });
  const rows: Array<[string, WorkspaceState, WorkspaceEvent, WorkspaceState]> = [
    ['로컬 화면에서 A 로그인 → 새로 시작(J2)', at(null, 0), { type: 'login', owner: A }, at(A, 1)],
    ['A 화면에서 같은 A 재로그인(만료 뒤) → 이어 감', at(A, 1), { type: 'login', owner: A }, at(A, 1)],
    ['A 화면에서 B 로그인 → 새로 시작', at(A, 1), { type: 'login', owner: B }, at(B, 2)],
    ['부팅 검증 → 주인만(세대 그대로)', at(null, 0), { type: 'bootVerified', owner: A }, at(A, 0)],
    ['로그아웃 완료 → +1, 주인 없음', at(A, 3), { type: 'logout' }, at(null, 4)],
    ['주인 있음 + 로컬 문맥 → 폐기(+1)', at(A, 3), { type: 'discard' }, at(null, 4)],
    ['주인 없음 + 로컬 문맥 → 그대로(로컬 작업 보존)', at(null, 3), { type: 'discard' }, at(null, 3)],
    ['강제 로그아웃·방송·신원 거부 → 그대로(주인 유지)', at(A, 2), { type: 'sessionReset' }, at(A, 2)],
  ];
  it.each(rows)('%s', (_name, from, event, to) => {
    expect(nextWorkspace(from, event)).toEqual(to);
  });

  it('바뀌지 않으면 같은 객체를 돌려준다(렌더를 만들지 않음)', () => {
    const a = at(A, 1);
    expect(nextWorkspace(a, { type: 'login', owner: A })).toBe(a);
    expect(nextWorkspace(INITIAL_WORKSPACE, { type: 'discard' })).toBe(INITIAL_WORKSPACE);
    expect(nextWorkspace(a, { type: 'sessionReset' })).toBe(a);
  });

  it('A 로그인 → 강제 리셋 → A 로그인은 세대 유지 / B 로그인은 +1', () => {
    let s = nextWorkspace(INITIAL_WORKSPACE, { type: 'login', owner: A });
    s = nextWorkspace(s, { type: 'sessionReset' });
    expect(nextWorkspace(s, { type: 'login', owner: A })).toEqual(at(A, 1));
    expect(nextWorkspace(s, { type: 'login', owner: B })).toEqual(at(B, 2));
  });
});
