// @vitest-environment jsdom
//
// P-8(REFACTORING_ROADMAP Phase 2 P2-20) 회귀 방지 — 계획 Codex 지적: 독립형의 로컬 → 서버 이관(collectLocalPatients 독립형
// 경로)은 workspaceRepository를 거치지 않고 storage.js의 load 함수를 직접 부른다. storage.js의 마이그레이션을 빼면 구형
// `moduleId + data.module` 환자가 그대로 업로드되고 서버 스키마가 data.module을 버려 **평가 데이터가 사라진다**.
// 여기서는 실제 이관 경로(runMigration → collectLocalPatients → migrateToServer → pushPatient)의 POST 본문에
// modules·activeModules가 채워지는지 끝까지 본다. (P-8은 위쪽 층의 중복만 제거하고 storage.js의 마이그레이션은 유지한다.)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../httpClient', () => ({
  requestJson: vi.fn(async (path, { body } = {}) => ({ ...body, sync: { serverId: body?.id, revision: 1 } })),
  requestBlob: vi.fn(),
  requestBlobPost: vi.fn(),
  requestMultipart: vi.fn(),
  configureHttpClient: vi.fn(),
}));

import { requestJson } from '../httpClient';
import { collectLocalPatients, runMigration } from '../localToServerMigrator';
import { makeBridgeStub } from '../../../testing/bridgeStub';
import goldenPatients from '../../fixtures/goldenPatients.json';

const kneeModule = goldenPatients[0].data.modules.knee;
const legacy = {
  id: '00000000-0000-4000-8000-00000000bb01',
  createdAt: '2024-05-01T00:00:00.000Z',
  moduleId: 'knee',
  data: { shared: { ...goldenPatients[0].data.shared, name: '구형이관', patientNo: 'LEGACY-PUSH' }, module: kneeModule },
};
const SESSION = { mode: 'intranet', apiBaseUrl: 'https://srv', user: { id: 'u1', name: '김의사', role: 'doctor' } };

const postBodies = () => requestJson.mock.calls
  .filter(([path, opts]) => path === '/api/patients' && opts?.method === 'POST')
  .map(([, opts]) => opts.body);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(requestJson).mockClear();
});

afterEach(() => {
  delete window.electron;
});

describe.each([
  ['웹 localStorage(자동저장 + 저장 목록)', () => {
    localStorage.setItem('wrEvalUnifiedAutoSave', JSON.stringify({ savedAt: 'x', patients: [legacy] }));
    localStorage.setItem('wrEvalUnifiedSavedItems', JSON.stringify([{ id: 'i1', name: 'A', patients: [legacy] }]));
  }],
  ['독립형 FS(fs* IPC)', () => {
    window.electron = makeBridgeStub('standalone', {
      overrides: {
        fsLoadItems: async () => [{ id: 'i1', name: 'A', patients: [legacy] }],
        fsLoadAutoSave: async () => ({ savedAt: 'x', patients: [legacy] }),
      },
    });
  }],
])('구형 환자 이관 — %s', (_label, seed) => {
  it('collectLocalPatients가 구형 환자를 신형식(modules·activeModules)으로 내보낸다', async () => {
    seed();
    const [p] = await collectLocalPatients();
    expect(p.id).toBe(legacy.id);
    expect(p.data.activeModules).toEqual(['knee']);
    expect(p.data.modules.knee).toEqual(kneeModule); // 무릎 평가 데이터가 그대로 옮겨진다
    expect('module' in p.data).toBe(false);
  });

  it('runMigration → pushPatient POST 본문에 modules·activeModules가 채워진다(평가 데이터 보존)', async () => {
    seed();
    const result = await runMigration({ session: SESSION, settings: {} });
    expect(result.failed).toEqual([]);
    const bodies = postBodies();
    expect(bodies).toHaveLength(1);
    const [body] = bodies;
    expect(body.id).toBe(legacy.id);
    expect(body.data.activeModules).toEqual(['knee']);
    expect(Object.keys(body.data.modules)).toEqual(['knee']);
    expect(body.data.modules.knee).toEqual(kneeModule);
    expect('module' in body.data).toBe(false);
    expect(body.data.shared.patientNo).toBe('LEGACY-PUSH');
    expect(body.data.shared.doctorName).toBe('김의사'); // stampDoctorName
  });
});
