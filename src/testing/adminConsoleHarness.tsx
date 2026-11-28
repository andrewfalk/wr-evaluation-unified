// 관리자 콘솔 특성화(P2-81a·b, Phase 2 C9 구간 C)용 도우미 — 단계마다 그 사이에 나간 서버 요청(메서드·주소·본문·헤더)과
// 탭 화면(DOM 한 요소 한 줄 · 제어되는 폼 상태)을 적는다. 서버 호출은 fetchRouter(또는 끊김을 따르는 래퍼)로 흉내 내므로
// 요청을 만드는 코드가 옮겨 가도(저장소 함수·다른 요청 클라이언트) 같은 기록이 나와야 한다.
import { act } from '@testing-library/react';
import { formState, serializeDom } from './renderEvaluation';

export interface RecordedRequest {
  method: string;
  url: string;
  body?: unknown;
  headers: unknown;
  /** 끊김을 따르는 래퍼를 쓸 때만: 요청에 signal이 실렸는지, 응답 전에 끊겼는지. */
  signal?: 'none' | 'live' | 'aborted';
}

export interface AdminStep {
  step: string;
  requests: RecordedRequest[];
  dom: string[];
  form: string[];
  /** 그 단계에서 띄운 확인창 문구(전역 confirm stub). */
  dialogs?: string[];
  /** 그 단계에서 클립보드에 쓴 글자. */
  clipboard?: string[];
}

interface CallLike {
  method: string;
  url: string;
  body?: unknown;
  headers?: unknown;
  signal?: 'none' | 'live' | 'aborted';
}

interface RouterLike {
  calls: CallLike[];
}

export interface StepRecorder {
  steps: AdminStep[];
  /** 지금까지의 요청을 기록하지 않고 넘긴다(앞 탭의 열기 요청 등). */
  skip(): CallLike[];
  snap(step: string, extra?: Pick<AdminStep, 'dialogs' | 'clipboard'>): AdminStep;
}

function toRecorded(call: CallLike): RecordedRequest {
  return {
    method: call.method,
    url: call.url,
    ...(call.body !== undefined ? { body: call.body } : {}),
    headers: call.headers,
    ...(call.signal !== undefined ? { signal: call.signal } : {}),
  };
}

export function createStepRecorder(router: RouterLike, root: () => Element | null): StepRecorder {
  const steps: AdminStep[] = [];
  let seen = 0;
  const take = (): CallLike[] => {
    const out = router.calls.slice(seen);
    seen = router.calls.length;
    return out;
  };
  return {
    steps,
    skip: take,
    snap(step, extra = {}) {
      const el = root();
      const entry: AdminStep = {
        step,
        requests: take().map(toRecorded),
        dom: el ? serializeDom(el) : [],
        form: el ? formState(el) : [],
        ...extra,
      };
      steps.push(entry);
      return entry;
    },
  };
}

/** 응답 처리(fetch → json → setState)가 끝날 때까지 몇 번 양보한다. setTimeout은 진짜여야 한다(가짜 타이머면 advance로). */
export async function flush(rounds = 5): Promise<void> {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await new Promise<void>(resolve => { setTimeout(resolve, 0); });
  });
}

export interface Deferred {
  promise: Promise<void>;
  release(): void;
}

/** 응답을 붙잡아 두었다가 release()로 놓는다 — 응답 전 화면(로딩·처리 중 표시)을 적을 때. */
export function deferred(): Deferred {
  let release: () => void = () => {};
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

export function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/** 글자가 정확히 같은 버튼(앞뒤 공백 제외). 여럿이면 index번째. */
export function buttonByText(root: ParentNode, text: string, index = 0): HTMLButtonElement {
  const found = Array.from(root.querySelectorAll('button')).filter(b => (b.textContent || '').trim() === text);
  const button = found[index];
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

/** 글자를 품은 표의 행(첫 번째). */
export function rowContaining(root: ParentNode, text: string): HTMLTableRowElement {
  const row = Array.from(root.querySelectorAll('tr')).find(tr => (tr.textContent || '').includes(text));
  if (!row) throw new Error(`row not found: ${text}`);
  return row;
}

export function inputByPlaceholder(root: ParentNode, placeholder: string): HTMLInputElement {
  const input = Array.from(root.querySelectorAll('input')).find(i => i.placeholder === placeholder);
  if (!input) throw new Error(`input not found: ${placeholder}`);
  return input;
}
