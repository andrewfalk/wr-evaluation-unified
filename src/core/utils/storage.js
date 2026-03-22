// localStorage 통합 스토리지
import { migratePatients } from './data';

const SAVED_ITEMS_KEY = 'wrEvalUnifiedSavedItems';
const AUTO_SAVE_KEY = 'wrEvalUnifiedAutoSave';
const SETTINGS_KEY = 'wrEvalUnifiedSettings';

export const loadSavedItems = () => {
  const s = localStorage.getItem(SAVED_ITEMS_KEY);
  if (s) {
    try {
      const items = JSON.parse(s);
      // 각 저장 항목의 patients를 마이그레이션
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

export const savePatientsData = (saveName, patients, savedItems) => {
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
  localStorage.setItem(SAVED_ITEMS_KEY, JSON.stringify(items));
  localStorage.removeItem(AUTO_SAVE_KEY);
  return items;
};

export const deleteSavedItem = (id, savedItems) => {
  const items = savedItems.filter(x => x.id !== id);
  localStorage.setItem(SAVED_ITEMS_KEY, JSON.stringify(items));
  return items;
};

export const saveAutoSave = (patients) => {
  const data = { savedAt: new Date().toISOString(), patients };
  localStorage.setItem(AUTO_SAVE_KEY, JSON.stringify(data));
};

export const loadAutoSave = () => {
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

export const clearAutoSave = () => {
  localStorage.removeItem(AUTO_SAVE_KEY);
};

export const loadSettings = (defaults) => {
  const saved = localStorage.getItem(SETTINGS_KEY);
  if (saved) {
    try { return { ...defaults, ...JSON.parse(saved) }; }
    catch {}
  }
  return { ...defaults };
};

export const saveSettings = (settings) => {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
};
