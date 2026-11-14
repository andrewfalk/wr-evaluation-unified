// @vitest-environment jsdom
//
// T7·T8·T11 특성화(REFACTORING_ROADMAP Phase 2 P2-07). C1 코드모드(P2-13 — storage.js의 window.electron 13곳 →
// getFsBridge())와 P-8(P2-20 — 로드 시 중복 마이그레이션 제거)이 바꾸면 안 되는 동작을 얼린다.
//
// T7  storage.js 왕복 — 웹(localStorage)과 독립형 FS(window.electron.fs*) 두 경로.
// T8  workspaceRepository — 인트라넷 문맥이면 자동저장 load·save가 null(로컬 저장소를 건드리지 않음).
// T11 마이그레이션 멱등 + 로드 경로 스냅샷: storage.js load 함수의 **모든 호출처**(2026-11-14 grep —
//     workspaceRepository.loadSavedWorkspaces·loadAutoSavedWorkspace, localToServerMigrator.collectLocalPatients
//     독립형 경로)와 그 위 층(useWorkspacePersistence.getLoadablePatientsFromSnapshot)의 출력을 웹·FS별로
//     __goldens__/storage-load-paths.json에 고정한다. 입력에 구형(moduleId + data.module) 환자를 넣는다 —
//     P-8에서 storage.js의 마이그레이션을 빼면 collectLocalPatients가 구형 환자를 그대로 내보내 서버 업로드 중
//     평가 데이터가 소실된다(계획 Codex 지적). P2-20은 이 골든을 바꾸지 않고 통과해야 한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import goldenPatients from '../../fixtures/goldenPatients.json';
import { makeBridgeStub } from '../../../testing/bridgeStub';
import {
  clearAutoSave, deleteSavedItem, getDeviceId, loadAutoSave, loadSavedItems, loadSettings, loadSettingsAsync,
  migrateToFileStorage, saveAutoSave, savePatientsData, saveSettings,
} from '../storage';
import { migratePatient, migratePatients } from '../data';
import { migratePatientRecords } from '../../services/patientRecords';
import {
  loadAutoSavedWorkspace, loadSavedWorkspaces, saveAutoSavedWorkspace,
} from '../../services/workspaceRepository';
import { collectLocalPatients } from '../../services/localToServerMigrator';
import { getLoadablePatientsFromSnapshot } from '../../hooks/useWorkspacePersistence';

const SAVED_ITEMS_KEY = 'wrEvalUnifiedSavedItems';
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const DEVICE_ID_KEY = 'wrEvalUnifiedDeviceId';

// 구형 환자: 모듈 1개 시절 형식(moduleId + data.module) — 무릎 골든 환자의 모듈 데이터를 그대로 옮겨 담는다.
const legacyKneePatient = {
  id: '00000000-0000-4000-8000-00000000aa01',
  createdAt: '2024-05-01T00:00:00.000Z',
  moduleId: 'knee',
  data: {
    shared: { ...goldenPatients[0].data.shared, name: '구형환자', patientNo: 'LEGACY-01' },
    module: goldenPatients[0].data.modules.knee,
  },
};
// createdAt 없음 → shared.evaluationDate로 채움 / 그것도 없음 → (고정 시계 기준) 하루 전
const { createdAt: _drop, ...legacyNoCreatedAt } = { ...legacyKneePatient, id: '00000000-0000-4000-8000-00000000aa02' };
const legacyNoDates = {
  ...legacyNoCreatedAt,
  id: '00000000-0000-4000-8000-00000000aa04',
  data: { ...legacyNoCreatedAt.data, shared: { ...legacyNoCreatedAt.data.shared, evaluationDate: '' } },
};
const redacted = { id: '00000000-0000-4000-8000-00000000aa03', redacted: true };
const INPUT = [legacyKneePatient, legacyNoCreatedAt, legacyNoDates, goldenPatients[1], goldenPatients[2], redacted];

function standaloneFs(initial = {}) {
  const store = { items: initial.items ?? [], autoSave: initial.autoSave ?? null, settings: initial.settings ?? null };
  const bridge = makeBridgeStub('standalone', {
    overrides: {
      fsLoadItems: async () => structuredClone(store.items),
      fsSaveItem: async (item) => { store.items = [...store.items.filter((x) => x.id !== item.id), structuredClone(item)]; },
      fsDeleteItem: async (id) => { store.items = store.items.filter((x) => x.id !== id); },
      fsSaveAllPatients: async () => {},
      fsLoadAutoSave: async () => structuredClone(store.autoSave),
      fsSaveAutoSave: async (data) => { store.autoSave = structuredClone(data); },
      fsClearAutoSave: async () => { store.autoSave = null; },
      fsLoadSettings: async () => structuredClone(store.settings),
      fsSaveSettings: async (s) => { store.settings = structuredClone(s); },
      fsMigrate: async () => ({ migrated: true }),
    },
  });
  return { bridge, store };
}

beforeEach(() => {
  localStorage.clear();
  delete window.electron;
});

afterEach(() => {
  delete window.electron;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('T7 storage.js 왕복 — 웹(localStorage)', () => {
  it('저장 목록: save → load(마이그레이션 적용), 같은 이름은 교체, 저장하면 자동저장 삭제, delete', async () => {
    localStorage.setItem(AUTO_SAVE_KEY, '{"savedAt":"x","patients":[]}');
    let items = await savePatientsData('A', [goldenPatients[1]], []);
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
    items = await savePatientsData('B', [goldenPatients[2]], items);
    items = await savePatientsData('A', [goldenPatients[3]], items);
    expect(items.map((x) => [x.name, x.count])).toEqual([['A', 1], ['B', 1]]);
    const loaded = await loadSavedItems();
    expect(loaded.map((x) => x.name)).toEqual(['A', 'B']);
    expect(loaded[0].patients).toEqual(migratePatients([goldenPatients[3]]));
    const after = await deleteSavedItem(loaded[1].id, loaded);
    expect(after.map((x) => x.name)).toEqual(['A']);
    expect(JSON.parse(localStorage.getItem(SAVED_ITEMS_KEY)).map((x) => x.name)).toEqual(['A']);
  });

  it('저장 목록 JSON이 깨졌으면 키를 지우고 []', async () => {
    localStorage.setItem(SAVED_ITEMS_KEY, '{broken');
    await expect(loadSavedItems()).resolves.toEqual([]);
    expect(localStorage.getItem(SAVED_ITEMS_KEY)).toBeNull();
  });

  it('자동저장: save → load(마이그레이션 적용) → clear, 깨진 JSON은 지우고 null', async () => {
    await saveAutoSave([legacyKneePatient]);
    const saved = await loadAutoSave();
    expect(typeof saved.savedAt).toBe('string');
    expect(saved.patients).toEqual(migratePatients([legacyKneePatient]));
    await clearAutoSave();
    await expect(loadAutoSave()).resolves.toBeNull();
    localStorage.setItem(AUTO_SAVE_KEY, 'nope');
    await expect(loadAutoSave()).resolves.toBeNull();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
  });

  it('설정: 기본값 위에 저장값, 기본값이 intranet이면 integrationMode는 intranet 고정', async () => {
    await saveSettings({ theme: 'dark', integrationMode: 'local' });
    expect(loadSettings({ theme: 'light', fontSize: 'medium', integrationMode: 'local' }))
      .toEqual({ theme: 'dark', fontSize: 'medium', integrationMode: 'local' });
    expect(loadSettings({ theme: 'light', integrationMode: 'intranet' }).integrationMode).toBe('intranet');
    await expect(loadSettingsAsync({ fontSize: 'small' })).resolves.toEqual({ fontSize: 'small', theme: 'dark', integrationMode: 'local' });
    localStorage.setItem(SETTINGS_KEY, '{bad');
    expect(loadSettings({ theme: 'light' })).toEqual({ theme: 'light' });
  });

  it('디바이스 ID: 한 번 만들면 유지, 형식이 틀린 값은 교체', () => {
    const id = getDeviceId();
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(getDeviceId()).toBe(id);
    localStorage.setItem(DEVICE_ID_KEY, 'not-a-uuid');
    const next = getDeviceId();
    expect(next).not.toBe('not-a-uuid');
    expect(localStorage.getItem(DEVICE_ID_KEY)).toBe(next);
  });

  it('migrateToFileStorage는 웹에서 아무것도 하지 않는다', async () => {
    localStorage.setItem(AUTO_SAVE_KEY, '{"patients":[]}');
    await migrateToFileStorage();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBe('{"patients":[]}');
  });
});

describe('T7 storage.js 왕복 — 독립형 FS(window.electron.fs*)', () => {
  it('저장 목록: fsSaveItem·fsSaveAllPatients·fsClearAutoSave 호출, 같은 이름은 옛 항목 fsDeleteItem, localStorage는 쓰지 않음', async () => {
    const { bridge, store } = standaloneFs();
    window.electron = bridge;
    let items = await savePatientsData('A', [goldenPatients[1]], []);
    const firstId = items[0].id;
    items = await savePatientsData('A', [goldenPatients[2]], items);
    expect(bridge.__callsOf('fsDeleteItem')).toEqual([[firstId]]);
    expect(bridge.__callsOf('fsSaveAllPatients')).toHaveLength(2);
    expect(bridge.__callsOf('fsClearAutoSave')).toHaveLength(2);
    expect(store.items.map((x) => x.name)).toEqual(['A']);
    expect(localStorage.getItem(SAVED_ITEMS_KEY)).toBeNull();
    const loaded = await loadSavedItems();
    expect(loaded[0].patients).toEqual(migratePatients([goldenPatients[2]]));
    await deleteSavedItem(loaded[0].id, loaded);
    expect(store.items).toEqual([]);
  });

  it('자동저장·설정: FS로 왕복, 설정은 localStorage에도 남김(동기 loadSettings 폴백), FS 설정이 없으면 localStorage', async () => {
    const { bridge, store } = standaloneFs();
    window.electron = bridge;
    await saveAutoSave([legacyKneePatient]);
    expect(store.autoSave.patients).toEqual([legacyKneePatient]); // 저장은 원본 그대로
    expect((await loadAutoSave()).patients).toEqual(migratePatients([legacyKneePatient]));
    await clearAutoSave();
    expect(store.autoSave).toBeNull();
    await expect(loadSettingsAsync({ theme: 'light' })).resolves.toEqual({ theme: 'light' });
    await saveSettings({ theme: 'dark' });
    expect(store.settings).toEqual({ theme: 'dark' });
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY))).toEqual({ theme: 'dark' });
    await expect(loadSettingsAsync({ theme: 'light', fontSize: 'm' })).resolves.toEqual({ theme: 'dark', fontSize: 'm' });
  });

  it('migrateToFileStorage: localStorage 저장분을 fsMigrate로 넘기고, 성공하면 저장 목록·자동저장 키만 지움', async () => {
    const { bridge } = standaloneFs();
    window.electron = bridge;
    localStorage.setItem(SAVED_ITEMS_KEY, '[{"id":"i1","name":"A","patients":[]}]');
    localStorage.setItem(AUTO_SAVE_KEY, '{"patients":[]}');
    localStorage.setItem(SETTINGS_KEY, '{"theme":"dark"}');
    await migrateToFileStorage();
    expect(bridge.__callsOf('fsMigrate')).toEqual([[{
      savedItems: [{ id: 'i1', name: 'A', patients: [] }], autoSave: { patients: [] }, settings: { theme: 'dark' },
    }]]);
    expect(localStorage.getItem(SAVED_ITEMS_KEY)).toBeNull();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBeNull();
    expect(localStorage.getItem(SETTINGS_KEY)).toBe('{"theme":"dark"}');
  });
});

describe('T8 workspaceRepository — 인트라넷 문맥 자동저장', () => {
  it.each([
    ['session', { session: { mode: 'intranet' }, settings: {} }],
    ['settings', { session: { mode: 'local' }, settings: { integrationMode: 'intranet' } }],
  ])('%s가 인트라넷이면 load·save 모두 null, 로컬 자동저장 키를 읽지도 쓰지도 않는다', async (_label, context) => {
    const before = JSON.stringify({ savedAt: 'x', patients: [goldenPatients[1]] });
    localStorage.setItem(AUTO_SAVE_KEY, before);
    // 자동저장 키 접근을 직접 감시한다(#288 Codex 권고 — 반환값만으로는 "읽고 버림"·"덮어쓰고 null"을 못 잡는다).
    const touched = [];
    for (const method of ['getItem', 'setItem', 'removeItem']) {
      const original = Storage.prototype[method];
      vi.spyOn(Storage.prototype, method).mockImplementation(function spy(key, ...rest) {
        if (key === AUTO_SAVE_KEY) touched.push(method);
        return original.call(this, key, ...rest);
      });
    }
    await expect(loadAutoSavedWorkspace(context)).resolves.toBeNull();
    await expect(saveAutoSavedWorkspace({ patients: [goldenPatients[2]], ...context })).resolves.toBeNull();
    expect(touched).toEqual([]);
    vi.restoreAllMocks();
    expect(localStorage.getItem(AUTO_SAVE_KEY)).toBe(before);
  });

  it('로컬 문맥이면 storage.js로 저장·복원(환자 레코드 메타 보강)', async () => {
    const context = { session: { mode: 'local' }, settings: { integrationMode: 'local' } };
    await saveAutoSavedWorkspace({ patients: [goldenPatients[1]], ...context });
    const saved = await loadAutoSavedWorkspace(context);
    expect(saved.patients).toEqual(migratePatientRecords([goldenPatients[1]], context));
  });
});

describe('T11 마이그레이션 멱등', () => {
  beforeEach(() => useGoldenEnvironment());

  it('migratePatient(migratePatient(x)) = migratePatient(x) — 골든 환자 전원 + 구형 + 가림 처리', () => {
    for (const p of [...goldenPatients, ...INPUT]) {
      const once = migratePatient(p);
      expect(migratePatient(once)).toEqual(once);
    }
  });

  it('migratePatientRecords도 멱등(세 층 변환의 아래 두 층)', () => {
    const context = { session: { mode: 'local' } };
    const once = migratePatientRecords(INPUT, context);
    expect(migratePatientRecords(once, context)).toEqual(once);
  });

  it('구형 환자는 modules·activeModules로 옮겨지고 data.module은 사라진다', () => {
    const m = migratePatient(legacyKneePatient);
    expect(m.data.activeModules).toEqual(['knee']);
    expect(m.data.modules.knee).toEqual(expect.objectContaining({}));
    expect('module' in m.data).toBe(false);
    expect(m.phase).toBe('evaluation');
  });
});

// 같은 환자 출력이 경로마다 반복되므로 골든에는 서로 다른 환자 객체를 한 번씩만 두고(patients[]) 경로에는
// 그 번호("#n")를 적는다. 어느 경로든 출력이 1바이트라도 바뀌면 새 번호가 생겨 골든이 달라진다.
function dedupePatients(tree) {
  const patients = [];
  const index = new Map();
  const ref = (patient) => {
    const key = JSON.stringify(patient);
    if (!index.has(key)) { index.set(key, patients.length); patients.push(patient); }
    return `#${index.get(key)}`;
  };
  const walk = (node) => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    if ('data' in node && ('id' in node) && !('patients' in node)) return ref(node);
    if (node.redacted === true) return ref(node);
    return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
  };
  return { paths: walk(tree), patients };
}

describe('T11 로드 경로 스냅샷(storage.js load 호출처 전수)', () => {
  beforeEach(() => useGoldenEnvironment());

  const localContext = { session: { mode: 'local', user: { id: 'web-user', organizationId: 'local-web-workspace' } }, settings: { integrationMode: 'local' } };

  async function collectPaths() {
    return {
      'storage.loadSavedItems': await loadSavedItems(),
      'storage.loadAutoSave': await loadAutoSave(),
      'workspaceRepository.loadSavedWorkspaces': await loadSavedWorkspaces(localContext),
      'workspaceRepository.loadAutoSavedWorkspace': await loadAutoSavedWorkspace(localContext),
      'useWorkspacePersistence.getLoadablePatientsFromSnapshot(autosave)':
        getLoadablePatientsFromSnapshot((await loadAutoSavedWorkspace(localContext)).patients, localContext),
      'localToServerMigrator.collectLocalPatients(standalone)': await collectLocalPatients(),
    };
  }

  it('웹(localStorage) + 독립형 FS', async () => {
    const item = { id: 'item-1', name: '저장1', count: INPUT.length, savedAt: '2025-12-31T00:00:00.000Z', patients: INPUT };
    const autoSave = { savedAt: '2025-12-31T01:00:00.000Z', patients: INPUT };

    localStorage.setItem(SAVED_ITEMS_KEY, JSON.stringify([item]));
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(autoSave));
    const web = await collectPaths();

    localStorage.clear();
    const { bridge } = standaloneFs({ items: [item], autoSave });
    window.electron = bridge;
    const fs = await collectPaths();

    // 구형 환자가 collectLocalPatients(서버 업로드 입력)에서 신형식으로 나온다 — P-8 회귀 방지의 핵심.
    for (const out of [web, fs]) {
      const legacy = out['localToServerMigrator.collectLocalPatients(standalone)'].find((p) => p.id === legacyKneePatient.id);
      expect(legacy.data.activeModules).toEqual(['knee']);
      expect(legacy.data.modules.knee).toBeTruthy();
      expect('module' in legacy.data).toBe(false);
    }
    await expect(JSON.stringify(dedupePatients({ web, fs }), null, 2)).toMatchFileSnapshot('./__goldens__/storage-load-paths.json');
  });
});
