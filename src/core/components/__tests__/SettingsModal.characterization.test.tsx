// @vitest-environment jsdom
//
// 설정 화면 특성화 보강(P2-86a, Phase 2 C9 구간 A) — 설정 창을 vi.mock 없이 그려 지금 화면을 얼린다. 기존 스모크(ModalHost·앱)가
// 덮지 않는 것: '연결 확인'(서버 호출은 fetchRouter로 — 경로·메서드·대상 주소·횟수), 연결 진단 표시(성공·Mock·실패·확인 중),
// 테마·폰트·자동 저장, AI 키 구역(Electron 브리지 stub), 주소가 빈 인트라넷 맥락의 기본 주소 폴백(잠긴 주소 칸·진단 주소·진단 문구·
// '연결 확인'의 요청 대상). 뒤따르는 이동·분할 PR(P2-86b-ts · P2-86c)의 안전망이고, P2-87(기본 주소 통일)에서도 그대로여야 한다.
//
// 공개 저장소 규칙: 기본 인트라넷 주소는 이 테스트에도 골든에도 적지 않는다. 화면이 서버 주소 입력란의 placeholder로 그리는 값
// (= 화면의 기본 주소 상수)을 실행 중에 읽어, 골든에 저장하는 모든 글자(DOM 속성·텍스트, 폼 값, 기록한 요청 URL)에서
// `<DEFAULT_INTRANET_URL>`로 가린다. 가린 뒤 그 호스트 이름이 남지 않았는지도 단언한다.
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { formState, serializeDom } from '../../../testing/renderEvaluation';
import { createFetchRouter } from '../../../testing/fetchRouter';
import { resetIntegrationStatus } from '../../services/integrationStatus';
import { SettingsModal } from '../SettingsModal';

type Fields = Record<string, unknown>;

const MASK = '<DEFAULT_INTRANET_URL>';
const SYNTHETIC_URL = 'https://intranet.synthetic.test';

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

const originalFetch = globalThis.fetch;

beforeEach(() => {
  useGoldenEnvironment();
  resetIntegrationStatus();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  delete window.electron;
  resetIntegrationStatus();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const BASE_SETTINGS = {
  theme: 'light',
  fontSize: 'medium',
  hospitalName: '합성 병원',
  department: '직업환경의학과',
  doctorName: '합성 의사',
  autoSaveInterval: 30,
  integrationMode: 'local',
  apiBaseUrl: '',
  geminiApiKey: '',
  claudeApiKey: '',
};

interface SessionCase {
  mode: string;
  apiBaseUrl?: string;
  user?: { id: string; organizationId: string; name: string; role: string };
}

interface StatusCase {
  mode?: string;
  activeStore?: string;
  connectivity?: string;
  baseUrl?: string;
  mock?: boolean;
  source?: string;
  message?: string;
  lastCheckedAt?: string | null;
  lastError?: string | null;
  sessionInfo?: { userId: string | null; organizationId: string | null; authMode: string };
  mockDetails?: {
    scopeKey: string; userId: string; organizationId: string; authMode: string;
    workspaceCount: number; hasAutosave: boolean; storageFile: string; port: number;
  } | null;
  remoteDetails?: { workspaceCount: number } | null;
  meDetails?: { userName: string; userRole: string; orgName: string; capabilities: { ai: boolean } } | null;
}

const LOCAL_SESSION: SessionCase = { mode: 'local' };
const INTRANET_SESSION: SessionCase = {
  mode: 'intranet',
  apiBaseUrl: '',
  user: { id: 'synthetic-user', organizationId: 'synthetic-org', name: '합성 사용자', role: 'doctor' },
};

const STATUS_LOCAL: StatusCase = {
  mode: 'local', activeStore: 'local', connectivity: 'local', baseUrl: '', mock: false, source: 'system',
  message: 'Using local storage.', lastCheckedAt: null, lastError: null,
  sessionInfo: { userId: null, organizationId: null, authMode: 'local' }, mockDetails: null, remoteDetails: null, meDetails: null,
};

interface SettingsCase {
  settings?: Partial<typeof BASE_SETTINGS>;
  session?: SessionCase | null;
  integrationStatus?: StatusCase | null;
  withLogout?: boolean;
  withMigrate?: boolean;
  electron?: boolean;
}

function renderSettings(c: SettingsCase) {
  const calls: Array<[string, unknown]> = [];
  if (c.electron) {
    // AI 키 구역은 브리지에 analyzeAI가 있을 때만 그린다(detectRuntime().hasDirectAi).
    window.electron = { analyzeAI: async () => ({}) } as unknown as Window['electron'];
  }
  const settings = { ...BASE_SETTINGS, ...(c.settings || {}) };
  const view = render(
    <SettingsModal
      settings={settings}
      session={c.session === undefined ? LOCAL_SESSION : c.session}
      integrationStatus={c.integrationStatus === undefined ? STATUS_LOCAL : c.integrationStatus}
      onSave={(draft: unknown) => calls.push(['onSave', draft])}
      onClose={() => calls.push(['onClose', null])}
      onLogout={c.withLogout ? async () => { calls.push(['onLogout', null]); return true; } : undefined}
      onMigrate={c.withMigrate ? () => calls.push(['onMigrate', null]) : undefined}
      onPresetsImported={() => calls.push(['onPresetsImported', null])}
    />,
  );
  return { ...view, calls };
}

/** 화면이 그리는 기본 주소(서버 주소 입력란의 placeholder). 값을 테스트에 적지 않으려고 실행 중에 읽는다. */
function readDefaultUrl(container: HTMLElement): string {
  const input = Array.from(container.querySelectorAll<HTMLInputElement>('.settings-row input[type="text"]'))
    .find(el => el.closest('.settings-row')?.querySelector('label')?.textContent === '서버 주소');
  const value = input?.getAttribute('placeholder') || '';
  if (!value) throw new Error('서버 주소 입력란의 placeholder가 비어 있다');
  return value;
}

function maskWith(defaultUrl: string) {
  const mask = (value: unknown): unknown => {
    if (typeof value === 'string') return value.split(defaultUrl).join(MASK);
    if (Array.isArray(value)) return value.map(mask);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Fields).map(([k, v]) => [k, mask(v)]));
    }
    return value;
  };
  return mask;
}

function snapshot(container: HTMLElement) {
  return { dom: serializeDom(container), form: formState(container) };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(b => b.textContent === text);
  if (!button) throw new Error(`버튼 없음: ${text}`);
  return button;
}

function inputOfRow(container: HTMLElement, label: string): HTMLInputElement | HTMLSelectElement {
  const row = Array.from(container.querySelectorAll('.settings-row')).find(r => r.querySelector('label')?.textContent === label);
  const input = row?.querySelector<HTMLInputElement | HTMLSelectElement>('input, select');
  if (!input) throw new Error(`입력란 없음: ${label}`);
  return input;
}

async function finishGolden(result: Fields, defaultUrl: string, file: string) {
  const json = goldenJson(maskWith(defaultUrl)(result));
  // 가린 뒤에는 기본 주소의 호스트 이름이 어디에도 남지 않아야 한다(공개 저장소).
  expect(json.includes(new URL(defaultUrl).hostname)).toBe(false);
  await expect(json).toMatchFileSnapshot(file);
}

// ── 첫 렌더 ───────────────────────────────────────────────────────────────────────────────────────
const STATUS_CONNECTED: StatusCase = {
  ...STATUS_LOCAL, mode: 'intranet', activeStore: 'remote', connectivity: 'connected', baseUrl: SYNTHETIC_URL, source: 'probe',
  message: `Connected to intranet at ${SYNTHETIC_URL}.`, lastCheckedAt: '2026-01-01T00:00:00.000Z',
  sessionInfo: { userId: 'synthetic-user', organizationId: 'synthetic-org', authMode: 'intranet' },
  remoteDetails: { workspaceCount: 3 },
  meDetails: { userName: '합성 사용자', userRole: 'doctor', orgName: '합성 기관', capabilities: { ai: true } },
};
const STATUS_MOCK: StatusCase = {
  ...STATUS_LOCAL, mode: 'intranet', activeStore: 'remote', connectivity: 'connected', baseUrl: SYNTHETIC_URL, mock: true,
  message: `Connected to mock intranet at ${SYNTHETIC_URL}.`, lastCheckedAt: '2026-01-01T00:00:00.000Z',
  mockDetails: { scopeKey: 'synthetic-scope', userId: 'synthetic-user', organizationId: 'synthetic-org', authMode: 'intranet', workspaceCount: 0, hasAutosave: false, storageFile: 'synthetic.json', port: 3001 },
  remoteDetails: { workspaceCount: 9 },
};
const STATUS_FALLBACK: StatusCase = {
  ...STATUS_LOCAL, mode: 'intranet', activeStore: 'local', connectivity: 'fallback', baseUrl: SYNTHETIC_URL,
  message: `Remote storage unavailable at ${SYNTHETIC_URL}. Falling back to local storage.`, lastCheckedAt: 'not-a-date',
  lastError: 'Request failed (500)',
};
const STATUS_CHECKING: StatusCase = {
  ...STATUS_LOCAL, mode: 'intranet', connectivity: 'checking', baseUrl: '', message: 'Checking intranet endpoint at /api.',
  lastCheckedAt: '2026-01-01T00:00:00.000Z',
};

const SCREEN_CASES: Array<[string, SettingsCase]> = [
  ['local:default', {}],
  ['local:no-status', { integrationStatus: null }],
  ['local:intranet-draft-with-url', { settings: { integrationMode: 'intranet', apiBaseUrl: `${SYNTHETIC_URL}/` } }],
  ['local:intranet-draft-empty-url', { settings: { integrationMode: 'intranet', apiBaseUrl: '' } }],
  ['intranet:locked-empty-url', { settings: { integrationMode: 'intranet' }, session: INTRANET_SESSION, withLogout: true, withMigrate: true }],
  ['intranet:locked-session-url', { settings: { integrationMode: 'intranet' }, session: { ...INTRANET_SESSION, apiBaseUrl: SYNTHETIC_URL }, withLogout: true }],
  ['intranet:locked-no-logout', { settings: { integrationMode: 'intranet' }, session: INTRANET_SESSION }],
  ['status:connected', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL }, integrationStatus: STATUS_CONNECTED }],
  ['status:mock', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL }, integrationStatus: STATUS_MOCK }],
  ['status:fallback', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL }, integrationStatus: STATUS_FALLBACK }],
  ['status:checking', { settings: { integrationMode: 'intranet' }, integrationStatus: STATUS_CHECKING }],
  ['electron:ai-keys', { electron: true, settings: { geminiApiKey: 'synthetic-gemini', claudeApiKey: '' } }],
];

describe('P2-86a — 설정 화면', () => {
  it('사례별 첫 렌더', async () => {
    const result: Fields = {};
    let defaultUrl = '';
    for (const [name, c] of SCREEN_CASES) {
      const view = renderSettings(c);
      defaultUrl = readDefaultUrl(view.container);
      result[name] = { ...snapshot(view.container), calls: view.calls };
      view.unmount();
      delete window.electron;
    }
    await finishGolden(result, defaultUrl, './__goldens__/settings-screen.json');
  });

  it('입력 조작 → 저장·취소·로그아웃·이전 콜백', async () => {
    const result: Fields = {};
    let defaultUrl = '';

    // 테마·폰트·병원명·자동 저장·저장 방식·서버 주소를 바꾸고 저장 → onSave의 draft
    {
      const view = renderSettings({ electron: true });
      defaultUrl = readDefaultUrl(view.container);
      const radio = (name: string, value: string) => {
        const input = view.container.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
        if (!input) throw new Error(`라디오 없음: ${name}=${value}`);
        return input;
      };
      act(() => { fireEvent.click(radio('theme', 'dark')); });
      act(() => { fireEvent.click(radio('fontSize', 'large')); });
      act(() => { fireEvent.change(inputOfRow(view.container, '병원명'), { target: { value: '합성 병원 2' } }); });
      act(() => { fireEvent.change(inputOfRow(view.container, '저장 간격'), { target: { value: '0' } }); });
      act(() => { fireEvent.change(inputOfRow(view.container, '데이터 저장 방식'), { target: { value: 'intranet' } }); });
      act(() => { fireEvent.change(inputOfRow(view.container, '서버 주소'), { target: { value: ` ${SYNTHETIC_URL}/ ` } }); });
      act(() => { fireEvent.change(inputOfRow(view.container, 'Gemini API Key'), { target: { value: 'synthetic-key' } }); });
      const afterEdit = snapshot(view.container);
      act(() => { fireEvent.click(buttonByText(view.container, '저장')); });
      act(() => { fireEvent.click(buttonByText(view.container, '취소')); });
      result.editAndSave = { afterEdit, calls: view.calls };
      view.unmount();
      delete window.electron;
    }

    // 오버레이 클릭은 닫기, 창 안쪽 클릭은 닫지 않는다
    {
      const view = renderSettings({});
      const overlay = view.container.querySelector('.modal-overlay');
      const modal = view.container.querySelector('.settings-modal');
      if (!overlay || !modal) throw new Error('모달 구조 없음');
      act(() => { fireEvent.click(modal); });
      act(() => { fireEvent.click(overlay); });
      result.overlayClick = { calls: view.calls };
      view.unmount();
    }

    // 인트라넷 잠김: 로그아웃(확인되면 닫기 · 취소되면 그대로) · 데이터 이전
    for (const started of [true, false]) {
      const calls: Array<[string, unknown]> = [];
      const view = render(
        <SettingsModal
          settings={{ ...BASE_SETTINGS, integrationMode: 'intranet' }}
          session={INTRANET_SESSION}
          integrationStatus={STATUS_LOCAL}
          onSave={(draft: unknown) => calls.push(['onSave', draft])}
          onClose={() => calls.push(['onClose', null])}
          onLogout={async () => { calls.push(['onLogout', null]); return started; }}
          onMigrate={() => calls.push(['onMigrate', null])}
          onPresetsImported={() => calls.push(['onPresetsImported', null])}
        />,
      );
      await act(async () => { fireEvent.click(buttonByText(view.container, '로그아웃')); });
      act(() => { fireEvent.click(buttonByText(view.container, '이 PC의 로컬 환자 데이터를 서버로 이전')); });
      result[`logout:${started ? 'started' : 'cancelled'}`] = { calls };
      view.unmount();
    }

    // 부모가 settings·integrationStatus를 새로 주면 입력 중인 값과 진단이 그 값으로 바뀐다
    {
      const view = renderSettings({});
      act(() => { fireEvent.change(inputOfRow(view.container, '병원명'), { target: { value: '입력 중' } }); });
      view.rerender(
        <SettingsModal
          settings={{ ...BASE_SETTINGS, hospitalName: '부모가 준 값' }}
          session={LOCAL_SESSION}
          integrationStatus={STATUS_FALLBACK}
          onSave={() => {}}
          onClose={() => {}}
          onLogout={undefined}
          onMigrate={undefined}
          onPresetsImported={() => {}}
        />,
      );
      result.propsReplaced = snapshot(view.container);
      view.unmount();
    }

    await finishGolden(result, defaultUrl, './__goldens__/settings-actions.json');
  });

  it("'연결 확인' → 요청·진단 표시", async () => {
    const result: Fields = {};
    let defaultUrl = '';
    const me = { user: { name: '합성 사용자', role: 'doctor' }, org: { name: '합성 기관' }, capabilities: { ai: false } };
    const routeSets: Array<[string, SettingsCase, Record<string, unknown>]> = [
      ['local', {}, {}],
      ['intranet-draft:remote-ok', { settings: { integrationMode: 'intranet', apiBaseUrl: `${SYNTHETIC_URL}/` } }, {
        'GET /api/mock/status': () => ({ status: 404, body: { error: 'not found' } }),
        'GET /api/auth/me': me,
        'GET /api/workspaces': { items: [{ id: 'w1' }, { id: 'w2' }] },
      }],
      ['intranet-draft:mock-ok', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } }, {
        'GET /api/mock/status': { scope: { scopeKey: 'synthetic-scope', userId: 'u', organizationId: 'o', authMode: 'intranet' }, workspaceCount: 2, hasAutosave: true, storageFile: 'synthetic.json', port: 3001 },
      }],
      ['intranet-draft:me-fails', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } }, {
        'GET /api/mock/status': () => ({ status: 405, body: {} }),
        'GET /api/auth/me': () => ({ status: 500, body: { error: '합성 서버 오류' } }),
      }],
      ['intranet-draft:workspaces-fails', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } }, {
        'GET /api/mock/status': () => ({ status: 404, body: {} }),
        'GET /api/auth/me': me,
        'GET /api/workspaces': () => ({ status: 503, body: {} }),
      }],
      // 네트워크 실패(브라우저 fetch가 TypeError로 reject).
      ['intranet-draft:network-error', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } }, {
        'GET /api/mock/status': () => { throw new TypeError('Failed to fetch'); },
      }],
      // 404·405가 아닌 실패는 /api/auth/me로 넘어가지 않고 바로 폴백이다.
      ['intranet-draft:mock-status-500', { settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } }, {
        'GET /api/mock/status': () => ({ status: 500, body: { error: '합성 서버 오류' } }),
      }],
      ['intranet-locked:empty-url', { settings: { integrationMode: 'intranet' }, session: INTRANET_SESSION }, {
        'GET /api/mock/status': () => ({ status: 404, body: {} }),
        'GET /api/auth/me': me,
        'GET /api/workspaces': { items: [] },
      }],
      ['local-draft-empty-url-intranet', { settings: { integrationMode: 'local' } }, {
        'GET /api/mock/status': () => ({ status: 404, body: {} }),
        'GET /api/auth/me': me,
        'GET /api/workspaces': { items: [] },
      }],
    ];
    for (const [name, c, routes] of routeSets) {
      const router = createFetchRouter(routes);
      globalThis.fetch = router.fetch as typeof fetch;
      const view = renderSettings(c);
      defaultUrl = readDefaultUrl(view.container);
      if (name === 'local-draft-empty-url-intranet') {
        // 저장하지 않은 입력값(저장 방식만 인트라넷, 주소 비움)으로 진단한다.
        act(() => { fireEvent.change(inputOfRow(view.container, '데이터 저장 방식'), { target: { value: 'intranet' } }); });
      }
      const before = snapshot(view.container);
      await act(async () => { fireEvent.click(buttonByText(view.container, '연결 확인')); });
      result[name] = {
        hintBefore: view.container.querySelector('.settings-inline-hint')?.textContent ?? null,
        before: name === 'local-draft-empty-url-intranet' ? before : undefined,
        requests: router.calls.map(call => ({ method: call.method, url: call.url, body: call.body ?? null })),
        unhandled: router.unhandled,
        after: snapshot(view.container),
      };
      view.unmount();
    }

    // 확인 중에는 버튼이 '확인 중...'으로 잠긴다 — 응답을 붙잡아 두고 그 사이 화면을 적는다.
    {
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => { release = resolve; });
      const router = createFetchRouter({
        'GET /api/mock/status': async () => { await gate; return { status: 404, body: {} }; },
        'GET /api/auth/me': me,
        'GET /api/workspaces': { items: [] },
      });
      globalThis.fetch = router.fetch as typeof fetch;
      const view = renderSettings({ settings: { integrationMode: 'intranet', apiBaseUrl: SYNTHETIC_URL } });
      await act(async () => { fireEvent.click(buttonByText(view.container, '연결 확인')); });
      const pending = Array.from(view.container.querySelectorAll('.settings-inline-actions button')).map(b => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled }));
      await act(async () => { release(); await gate; });
      const done = Array.from(view.container.querySelectorAll('.settings-inline-actions button')).map(b => ({ text: b.textContent, disabled: (b as HTMLButtonElement).disabled }));
      result.pendingButton = { pending, done, requestCount: router.calls.length };
      view.unmount();
    }

    await finishGolden(result, defaultUrl, './__goldens__/settings-check-connection.json');
  });
});
