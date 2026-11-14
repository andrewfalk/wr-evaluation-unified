// @vitest-environment jsdom
// T1·T2 특성화(REFACTORING_ROADMAP Phase 2 P2-05) — C1 플랫폼 어댑터(P2-10~12)가 인트라넷 판정·baseUrl 결정을
// 한 곳(src/platform/dataMode.ts)으로 모으기 전에, 지금 흩어진 구현들의 동작을 그대로 얼린다. P2-11·12는 이
// 파일을 바꾸지 않고 통과해야 한다(바꿀 수 있는 것은 import 경로뿐).
//
// T1 인트라넷 판정 — 의미가 다른 세 변형(계획 C1 "술어 3개"):
//   ① 문맥(session OR settings): App.jsx·useServerConfig·useIntegrationStatus·integrationStatus·
//      workspaceRepository·workspaceAutosavePolicy — 6벌. 아래에서 export된 것과 관찰 가능한 동작으로 확인.
//   ② 세션만(session.mode === 'intranet'): useAIAvailable·patientScope·analysisClient·videoAnalysisClient 등.
//   ③ refresh 자격(!session?.mode || session.mode === 'intranet'): httpClient의 401-refresh.
// T2 baseUrl 우선순위 — session → settings → ''(3벌 + integrationStatus의 정규화판), analysisClient의 웹 경로만
//   settings → session 역순(P2-12에서 통일 예정 — flagged, 아래 "역순" 테스트를 그때 의도 갱신).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/httpClient', () => ({
  requestJson: vi.fn(),
  requestMultipart: vi.fn(),
  requestBlob: vi.fn(),
  configureHttpClient: vi.fn(),
}));

import { requestJson } from '../services/httpClient';
import { isIntranetWorkspaceMode, shouldUseWorkspaceAutosave } from '../utils/workspaceAutosavePolicy';
import { inspectIntegrationStatus } from '../services/integrationStatus';
import { loadAutoSavedWorkspace, loadSavedWorkspaces } from '../services/workspaceRepository';
import { useAIAvailable } from '../hooks/useAIAvailable';
import { getDefaultPatientScope, normalizePatientScopeForSession } from '../utils/patientScope';
import { isVideoAnalysisSupported, createClip } from '../services/videoAnalysisClient';
import { pullPatients } from '../services/patientServerRepository';
import { loadRemoteWorkspaces } from '../services/intranetWorkspaceRepository';
import { analyzeAIRequest } from '../services/analysisClient';

const SESSION_MODES = [undefined, 'local', 'intranet'];
const SETTINGS_MODES = [undefined, 'local', 'intranet'];
const cases = [];
for (const s of SESSION_MODES) for (const t of SETTINGS_MODES) cases.push([s, t]);
const ctx = (sessionMode, settingsMode) => ({
  session: sessionMode === undefined ? {} : { mode: sessionMode },
  settings: settingsMode === undefined ? {} : { integrationMode: settingsMode },
});

// 기대 진리표(변형별) — P2-10의 dataMode 술어 테스트도 이 표를 쓴다.
const contextTruth = ([s, t]) => s === 'intranet' || t === 'intranet';
const sessionTruth = ([s]) => s === 'intranet';

beforeEach(() => {
  vi.mocked(requestJson).mockReset();
  localStorage.clear();
});

afterEach(() => {
  delete window.electron;
  vi.unstubAllGlobals();
});

describe('T1 ① 문맥 판정(session OR settings)', () => {
  it.each(cases)('workspaceAutosavePolicy.isIntranetWorkspaceMode — %s', (...c) => {
    expect(isIntranetWorkspaceMode(ctx(...c))).toBe(contextTruth(c));
    expect(shouldUseWorkspaceAutosave(ctx(...c))).toBe(!contextTruth(c));
  });

  it('인자가 없거나 null이어도 false', () => {
    expect(isIntranetWorkspaceMode()).toBe(false);
    expect(isIntranetWorkspaceMode({ session: null, settings: null })).toBe(false);
  });

  it.each(cases)('integrationStatus.inspectIntegrationStatus — 인트라넷 문맥일 때만 서버를 본다 — %s', async (...c) => {
    vi.mocked(requestJson).mockRejectedValue(Object.assign(new Error('offline'), { status: 0 }));
    const status = await inspectIntegrationStatus(ctx(...c));
    expect(requestJson.mock.calls.length > 0).toBe(contextTruth(c));
    if (!contextTruth(c)) expect(status).toMatchObject({ mode: 'local', activeStore: 'local' });
  });

  it.each(cases)('workspaceRepository: 원격 저장소 사용 = 문맥 판정 — %s', async (...c) => {
    vi.mocked(requestJson).mockResolvedValue({ items: [] });
    await loadSavedWorkspaces(ctx(...c));
    const remote = requestJson.mock.calls.some(([path]) => path === '/api/workspaces');
    expect(remote).toBe(contextTruth(c));
  });

  it.each(cases)('workspaceRepository.loadAutoSavedWorkspace: 인트라넷 문맥이면 null(요청 없음) — %s', async (...c) => {
    vi.mocked(requestJson).mockResolvedValue({ patients: [], savedAt: null });
    const saved = await loadAutoSavedWorkspace(ctx(...c));
    if (contextTruth(c)) {
      expect(saved).toBeNull();
      expect(requestJson).not.toHaveBeenCalled();
    }
  });
});

describe('T1 ② 세션만 판정(session.mode === intranet)', () => {
  it.each(cases)('useAIAvailable — %s', (...c) => {
    const { session, settings } = ctx(...c);
    // aiEnabled=false 서버 설정: 인트라넷 세션이면 false, 아니면(설정만 intranet이어도) 항상 true.
    expect(useAIAvailable({ serverConfig: { aiEnabled: false }, session, settings }).aiAvailable).toBe(!sessionTruth(c));
  });

  it.each(cases)('patientScope 기본값·정규화(비-doctor) — %s', (...c) => {
    const { session } = ctx(...c);
    const admin = { ...session, user: { role: 'admin' } };
    expect(getDefaultPatientScope(admin)).toBe(sessionTruth(c) ? 'all' : 'mine');
    expect(normalizePatientScopeForSession(admin, 'mine')).toBe(sessionTruth(c) ? 'all' : 'mine');
  });

  it.each(cases)('videoAnalysisClient.isVideoAnalysisSupported — %s', (...c) => {
    expect(isVideoAnalysisSupported(ctx(...c).session)).toBe(sessionTruth(c));
  });

  it.each(cases)('analysisClient: 서버 프록시(/api/ai/analyze)는 인트라넷 세션일 때만 — %s', async (...c) => {
    vi.mocked(requestJson).mockResolvedValue({ text: 'ok' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ text: 'web' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await analyzeAIRequest({ input: { a: 1 }, ...ctx(...c) });
    expect(requestJson.mock.calls.some(([path]) => path === '/api/ai/analyze')).toBe(sessionTruth(c));
    expect(fetchMock.mock.calls.length > 0).toBe(!sessionTruth(c));
  });
});

// ③ refresh 자격은 httpClient 내부 함수(canRefreshSession)라 httpClient.test.js가 동작으로 덮는다
// ("session.mode='local'이면 401에 refresh하지 않음" 3건, mode 없는 세션은 기존 동작). 여기서는 표만 남긴다.
describe('T1 ③ refresh 자격 표(참고 — httpClient.test.js가 동작으로 고정)', () => {
  const refreshEligible = (session) => !session?.mode || session.mode === 'intranet';
  it('mode 없음 → 자격 있음, local → 없음, intranet → 있음', () => {
    expect([undefined, {}, { mode: 'local' }, { mode: 'intranet' }].map(refreshEligible)).toEqual([true, true, false, true]);
  });
});

describe('T2 baseUrl 우선순위', () => {
  const both = { session: { mode: 'intranet', apiBaseUrl: 'https://from-session' }, settings: { integrationMode: 'intranet', apiBaseUrl: 'https://from-settings' } };
  const onlySettings = { session: { mode: 'intranet' }, settings: { integrationMode: 'intranet', apiBaseUrl: 'https://from-settings' } };
  const neither = { session: { mode: 'intranet' }, settings: { integrationMode: 'intranet' } };
  const baseUrlOf = (path) => requestJson.mock.calls.find(([p]) => p.startsWith(path))?.[1]?.baseUrl;

  // getBaseUrl 3벌: session → settings → ''(정규화하지 않음) — 세 구현 모두 같은 표로(#288 Codex 권고).
  const IMPLS = [
    ['patientServerRepository.pullPatients', (c) => pullPatients(c), '/api/patients'],
    ['intranetWorkspaceRepository.loadRemoteWorkspaces', (c) => loadRemoteWorkspaces(c), '/api/workspaces'],
    ['videoAnalysisClient.createClip', (c) => createClip({ id: 'p1', sync: { serverId: 'p1', syncStatus: 'synced' } }, { processId: 'x', purpose: 'analysis_upload', ...c }), '/api/video-analysis'],
  ];
  const CONTEXTS = [
    ['both → session', both, 'https://from-session'],
    ['settings만 → settings', onlySettings, 'https://from-settings'],
    ['둘 다 없음 → ""', neither, ''],
    ['정규화 안 함', { session: { mode: 'intranet', apiBaseUrl: ' https://s/ ' }, settings: {} }, ' https://s/ '],
  ];
  for (const [name, run, path] of IMPLS) {
    it.each(CONTEXTS)(`${name}: %s`, async (_label, context, expected) => {
      vi.mocked(requestJson).mockResolvedValue({ items: [] });
      await run(context).catch(() => {});
      expect(baseUrlOf(path)).toBe(expected);
    });
  }

  it('integrationStatus(getContextBaseUrl): session → settings, 앞뒤 공백·끝 "/" 제거', async () => {
    vi.mocked(requestJson).mockRejectedValue(Object.assign(new Error('x'), { status: 0 }));
    const status = await inspectIntegrationStatus({ session: { mode: 'intranet', apiBaseUrl: ' https://s/ ' }, settings: { apiBaseUrl: 'https://t' } });
    expect(requestJson.mock.calls[0][1].baseUrl).toBe('https://s');
    expect(status.baseUrl).toBe('https://s');
    requestJson.mockClear();
    await inspectIntegrationStatus({ session: { mode: 'intranet' }, settings: { apiBaseUrl: 'https://t/' } });
    expect(requestJson.mock.calls[0][1].baseUrl).toBe('https://t');
  });

  it('analysisClient 인트라넷 경로: session → settings', async () => {
    vi.mocked(requestJson).mockResolvedValue({});
    await analyzeAIRequest({ input: { a: 1 }, ...both });
    expect(baseUrlOf('/api/ai/analyze')).toBe('https://from-session');
    requestJson.mockClear();
    await analyzeAIRequest({ input: { a: 1 }, ...onlySettings });
    expect(baseUrlOf('/api/ai/analyze')).toBe('https://from-settings');
  });

  describe('analysisClient 웹(비인트라넷) 경로 — 현재는 settings → session 역순(P2-12에서 통일, flagged)', () => {
    const run = async (session, settings) => {
      const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await analyzeAIRequest({ input: { a: 1 }, session, settings });
      return fetchMock.mock.calls[0][0];
    };

    it('둘 다 있으면 settings가 이긴다(역순)', async () => {
      expect(await run({ mode: 'local', apiBaseUrl: 'https://s' }, { apiBaseUrl: 'https://t/' })).toBe('https://t/api/analyze');
    });

    it('settings에 없으면 session, 둘 다 없으면 상대 경로', async () => {
      expect(await run({ mode: 'local', apiBaseUrl: 'https://s/' }, {})).toBe('https://s/api/analyze');
      expect(await run({ mode: 'local' }, {})).toBe('/api/analyze');
    });

    it('settings 인자가 없으면 localStorage 설정을 읽는다', async () => {
      localStorage.setItem('wrEvalUnifiedSettings', JSON.stringify({ apiBaseUrl: 'https://stored' }));
      expect(await run({ mode: 'local', apiBaseUrl: 'https://s' }, undefined)).toBe('https://stored/api/analyze');
    });

    it('정상 상태 동치: useAppSettings가 settings URL을 session에 동기화하면 순서와 무관하게 같다', async () => {
      const url = 'https://same';
      expect(await run({ mode: 'local', apiBaseUrl: url }, { apiBaseUrl: url })).toBe(`${url}/api/analyze`);
    });
  });
});
