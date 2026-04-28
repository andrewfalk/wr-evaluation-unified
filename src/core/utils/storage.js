// 통합 스토리지 (웹: localStorage / Electron: 파일 시스템)
import { migratePatients } from './data';

const SAVED_ITEMS_KEY = 'wrEvalUnifiedSavedItems';
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';
const DEVICE_ID_KEY = 'wrEvalUnifiedDeviceId';

const isElectronFS = () => !!window.electron?.fsLoadAllPatients;

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      throw new Error('저장 공간이 부족합니다. 기존 저장 데이터를 삭제해주세요.');
    }
    throw e;
  }
}

// ======================================================
// 저장 목록 (savedItems)
// ======================================================

export const loadSavedItems = async () => {
  if (isElectronFS()) {
    const items = await window.electron.fsLoadItems();
    return (items || []).map(item => ({
      ...item,
      patients: item.patients ? migratePatients(item.patients) : []
    }));
  }
  // 웹: localStorage
  const s = localStorage.getItem(SAVED_ITEMS_KEY);
  if (s) {
    try {
      const items = JSON.parse(s);
      return items.map(item => ({
        ...item,
        patients: item.patients ? migratePatients(item.patients) : []
      }));
    }
    catch { localStorage.removeItem(SAVED_ITEMS_KEY); }
  }
  return [];
};

export const hasDuplicateName = (saveName, savedItems) => {
  return savedItems.some(x => x.name === saveName);
};

export const savePatientsData = async (saveName, patients, savedItems) => {
  const item = {
    id: crypto.randomUUID(),
    name: saveName,
    count: patients.length,
    savedAt: new Date().toISOString(),
    patients
  };
  const existingIndex = savedItems.findIndex(x => x.name === saveName);
  let items;
  if (existingIndex >= 0) {
    items = [...savedItems];
    items[existingIndex] = item;
  } else {
    items = [...savedItems, item];
  }

  if (isElectronFS()) {
    if (existingIndex >= 0 && savedItems[existingIndex].id !== item.id) {
      await window.electron.fsDeleteItem(savedItems[existingIndex].id);
    }
    await window.electron.fsSaveItem(item);
    await window.electron.fsSaveAllPatients(patients);
    await window.electron.fsClearAutoSave();
  } else {
    safeSetItem(SAVED_ITEMS_KEY, JSON.stringify(items));
    localStorage.removeItem(AUTO_SAVE_KEY);
  }
  return items;
};

export const deleteSavedItem = async (id, savedItems) => {
  const items = savedItems.filter(x => x.id !== id);
  if (isElectronFS()) {
    await window.electron.fsDeleteItem(id);
  } else {
    safeSetItem(SAVED_ITEMS_KEY, JSON.stringify(items));
  }
  return items;
};

// ======================================================
// 자동저장
// ======================================================

export const saveAutoSave = async (patients) => {
  const data = { savedAt: new Date().toISOString(), patients };
  if (isElectronFS()) {
    await window.electron.fsSaveAutoSave(data);
  } else {
    safeSetItem(AUTO_SAVE_KEY, JSON.stringify(data));
  }
};

export const loadAutoSave = async () => {
  if (isElectronFS()) {
    const data = await window.electron.fsLoadAutoSave();
    if (data?.patients) data.patients = migratePatients(data.patients);
    return data;
  }
  // 웹: localStorage
  const saved = localStorage.getItem(AUTO_SAVE_KEY);
  if (saved) {
    try {
      const data = JSON.parse(saved);
      if (data.patients) data.patients = migratePatients(data.patients);
      return data;
    }
    catch { localStorage.removeItem(AUTO_SAVE_KEY); }
  }
  return null;
};

export const clearAutoSave = async () => {
  if (isElectronFS()) {
    await window.electron.fsClearAutoSave();
  } else {
    localStorage.removeItem(AUTO_SAVE_KEY);
  }
};

// ======================================================
// 설정
// ======================================================

export const loadSettings = (defaults) => {
  // 동기 함수 유지 (초기 렌더링에서 사용)
  // Electron에서도 첫 로드는 localStorage 폴백 후, 비동기로 갱신
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try { return { ...defaults, ...JSON.parse(saved) }; }
    catch { /* ignore parse errors, return defaults */ }
  }
  return { ...defaults };
};

export const loadSettingsAsync = async (defaults) => {
  if (isElectronFS()) {
    const settings = await window.electron.fsLoadSettings();
    if (settings) return { ...defaults, ...settings };
  }
  return loadSettings(defaults);
};

export const saveSettings = async (settings) => {
  if (isElectronFS()) {
    await window.electron.fsSaveSettings(settings);
  }
  // 항상 localStorage에도 저장 (동기 loadSettings 폴백용)
  safeSetItem(SETTINGS_KEY, JSON.stringify(settings));
};

// ======================================================
// localStorage → 파일 마이그레이션 (Electron 전용)
// ======================================================

export const migrateToFileStorage = async () => {
  if (!isElectronFS()) return;

  const savedItemsRaw = localStorage.getItem(SAVED_ITEMS_KEY);
  const autoSaveRaw = localStorage.getItem(AUTO_SAVE_KEY);
  const settingsRaw = localStorage.getItem(SETTINGS_KEY);

  let savedItems = null;
  let autoSave = null;
  let settings = null;

  try { savedItems = savedItemsRaw ? JSON.parse(savedItemsRaw) : null; } catch { /* ignore */ }
  try { autoSave = autoSaveRaw ? JSON.parse(autoSaveRaw) : null; } catch { /* ignore */ }
  try { settings = settingsRaw ? JSON.parse(settingsRaw) : null; } catch { /* ignore */ }

  // 마이그레이션할 데이터가 없으면 스킵
  if (!savedItems && !autoSave && !settings) return;

  const result = await window.electron.fsMigrate({ savedItems, autoSave, settings });
  if (result?.migrated) {
    // 마이그레이션 성공 시 localStorage 정리 (설정은 폴백용으로 유지)
    localStorage.removeItem(SAVED_ITEMS_KEY);
    localStorage.removeItem(AUTO_SAVE_KEY);
  }
};

// ======================================================
// 디바이스 ID
// ======================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Per-install stable identifier used for autosave isolation and device registration.
// Uses globalThis.localStorage so it can be mocked in unit tests (Node.js has no localStorage).
export function getDeviceId() {
  const storage = globalThis.localStorage;
  if (!storage) return crypto.randomUUID(); // SSR / non-browser fallback
  try {
    const existing = storage.getItem(DEVICE_ID_KEY);
    if (existing && UUID_RE.test(existing)) return existing;
    const id = crypto.randomUUID();
    storage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}
