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

// 저장원(자동저장·저장 목록)마다 다른 구형 환자를 둔다 — 한 저장원을 읽지 않는 회귀가 다른 저장원에 가려지지 않게
// (#300 Codex 권고). 둘 다 수집·업로드돼야 한다.
const legacyFromAutoSave = { ...legacy, id: '00000000-0000-4000-8000-00000000bb02', data: { ...legacy.data, shared: { ...legacy.data.shared, patientNo: 'LEGACY-AUTO' } } };
const legacyFromSavedItems = { ...legacy, id: '00000000-0000-4000-8000-00000000bb03', data: { ...legacy.data, shared: { ...legacy.data.shared, patientNo: 'LEGACY-SAVED' } } };

describe.each([
  ['웹 localStorage', () => {
    localStorage.setItem('wrEvalUnifiedAutoSave', JSON.stringify({ savedAt: 'x', patients: [legacyFromAutoSave] }));
    localStorage.setItem('wrEvalUnifiedSavedItems', JSON.stringify([{ id: 'i1', name: 'A', patients: [legacyFromSavedItems] }]));
  }],
  ['독립형 FS(fs* IPC)', () => {
    window.electron = makeBridgeStub('standalone', {
      overrides: {
        fsLoadItems: async () => [{ id: 'i1', name: 'A', patients: [legacyFromSavedItems] }],
        fsLoadAutoSave: async () => ({ savedAt: 'x', patients: [legacyFromAutoSave] }),
      },
    });
  }],
])('구형 환자 이관 — %s', (_label, seed) => {
  it('collectLocalPatients가 두 저장원의 구형 환자를 모두 신형식(modules·activeModules)으로 내보낸다', async () => {
    seed();
    const patients = await collectLocalPatients();
    expect(patients.map((p) => p.id).sort()).toEqual([legacyFromAutoSave.id, legacyFromSavedItems.id].sort());
    for (const p of patients) {
      expect(p.data.activeModules).toEqual(['knee']);
      expect(p.data.modules.knee).toEqual(kneeModule); // 무릎 평가 데이터가 그대로 옮겨진다
      expect('module' in p.data).toBe(false);
    }
  });

  it('runMigration → pushPatient POST 본문에 modules·activeModules가 채워진다(평가 데이터 보존, 두 저장원 모두)', async () => {
    seed();
    const result = await runMigration({ session: SESSION, settings: {} });
    expect(result.failed).toEqual([]);
    const bodies = postBodies();
    expect(bodies.map((b) => b.data.shared.patientNo).sort()).toEqual(['LEGACY-AUTO', 'LEGACY-SAVED']);
    for (const body of bodies) {
      expect(body.data.activeModules).toEqual(['knee']);
      expect(Object.keys(body.data.modules)).toEqual(['knee']);
      expect(body.data.modules.knee).toEqual(kneeModule);
      expect('module' in body.data).toBe(false);
      expect(body.data.shared.doctorName).toBe('김의사'); // stampDoctorName
    }
  });
});

describe('저장원 하나만 있을 때도 수집된다', () => {
  it('자동저장만', async () => {
    localStorage.setItem('wrEvalUnifiedAutoSave', JSON.stringify({ savedAt: 'x', patients: [legacyFromAutoSave] }));
    expect((await collectLocalPatients()).map((p) => p.id)).toEqual([legacyFromAutoSave.id]);
  });

  it('저장 목록만', async () => {
    localStorage.setItem('wrEvalUnifiedSavedItems', JSON.stringify([{ id: 'i1', name: 'A', patients: [legacyFromSavedItems] }]));
    expect((await collectLocalPatients()).map((p) => p.id)).toEqual([legacyFromSavedItems.id]);
  });
});
