// 통합 스토리지 (웹: localStorage / Electron: 파일 시스템)
import { migratePatients } from './data';

const SAVED_ITEMS_KEY = 'wrEvalUnifiedSavedItems';
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';

const isElectronFS = () => !!window.electron?.fsLoadAllPatients;

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
    id: Date.now(),
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
    await window.electron.fsSaveItem(item);
    await window.electron.fsSaveAllPatients(patients);
    await window.electron.fsClearAutoSave();
  } else {
    localStorage.setItem(SAVED_ITEMS_KEY, JSON.stringify(items));
    localStorage.removeItem(AUTO_SAVE_KEY);
  }
  return items;
};

export const deleteSavedItem = async (id, savedItems) => {
  const items = savedItems.filter(x => x.id !== id);
  if (isElectronFS()) {
    await window.electron.fsDeleteItem(id);
  } else {
    localStorage.setItem(SAVED_ITEMS_KEY, JSON.stringify(items));
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
    localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(data));
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
    catch {}
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
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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

  try { savedItems = savedItemsRaw ? JSON.parse(savedItemsRaw) : null; } catch {}
  try { autoSave = autoSaveRaw ? JSON.parse(autoSaveRaw) : null; } catch {}
  try { settings = settingsRaw ? JSON.parse(settingsRaw) : null; } catch {}

  // 마이그레이션할 데이터가 없으면 스킵
  if (!savedItems && !autoSave && !settings) return;

  const result = await window.electron.fsMigrate({ savedItems, autoSave, settings });
  if (result?.migrated) {
    // 마이그레이션 성공 시 localStorage 정리 (설정은 폴백용으로 유지)
    localStorage.removeItem(SAVED_ITEMS_KEY);
    localStorage.removeItem(AUTO_SAVE_KEY);
  }
};
