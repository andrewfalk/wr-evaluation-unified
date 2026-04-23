const CUSTOM_PRESETS_KEY = 'wrEvalUnifiedCustomPresets';

export const DEFAULT_CATEGORY = '미분류';

const isElectronFS = () => !!window.electron?.fsLoadAllPatients;

export function normalizePresetIdentityPart(value) {
  return String(value || '').trim();
}

export function buildPresetIdentity(preset = {}) {
  return [
    preset.jobName,
    preset.category,
    preset.description,
  ]
    .map(normalizePresetIdentityPart)
    .join('|||');
}

export function isSamePresetIdentity(left, right) {
  return buildPresetIdentity(left) === buildPresetIdentity(right);
}

export function getPresetCategory(preset) {
  const safePreset = preset || {};
  if (Object.prototype.hasOwnProperty.call(safePreset, '_customCategory')) {
    return safePreset._customCategory ?? '';
  }
  return safePreset.category ?? DEFAULT_CATEGORY;
}

export function getPresetDescription(preset) {
  const safePreset = preset || {};
  if (Object.prototype.hasOwnProperty.call(safePreset, '_customDescription')) {
    return safePreset._customDescription ?? '';
  }
  return safePreset.description ?? '';
}

function normalizePresetRecord(preset = {}) {
  return {
    ...preset,
    jobName: normalizePresetIdentityPart(preset.jobName),
    category: normalizePresetIdentityPart(preset.category) || DEFAULT_CATEGORY,
    description: normalizePresetIdentityPart(preset.description),
    modules: { ...(preset.modules || {}) },
  };
}

function loadCustomPresetsFromLocalStorage() {
  const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    localStorage.removeItem(CUSTOM_PRESETS_KEY);
    return [];
  }
}

function safeSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      throw new Error('저장 공간이 부족합니다. 기존 데이터를 정리해주세요.');
    }
    throw e;
  }
}

export function normalizeBuiltinPreset(raw) {
  return {
    id: `builtin-${raw.id}`,
    jobName: raw.jobName,
    category: raw.category,
    description: raw.description || '',
    source: 'builtin',
    createdAt: null,
    updatedAt: null,
    modules: {
      knee: {
        weight: raw.weight,
        squatting: raw.squatting,
        stairs: false,
        kneeTwist: false,
        startStop: false,
        tightSpace: false,
        kneeContact: false,
        jumpDown: false,
      },
    },
  };
}

export async function loadCustomPresets() {
  if (isElectronFS() && window.electron.fsLoadCustomPresets) {
    const presets = await window.electron.fsLoadCustomPresets();
    if (Array.isArray(presets) && presets.length > 0) {
      return presets;
    }

    const legacyPresets = loadCustomPresetsFromLocalStorage();
    if (legacyPresets.length > 0) {
      if (window.electron.fsSaveCustomPresets) {
        await window.electron.fsSaveCustomPresets(legacyPresets);
      }
      localStorage.removeItem(CUSTOM_PRESETS_KEY);
      return legacyPresets;
    }

    return Array.isArray(presets) ? presets : [];
  }

  return loadCustomPresetsFromLocalStorage();
}

async function saveCustomPresetsAll(list) {
  if (isElectronFS() && window.electron.fsSaveCustomPresets) {
    await window.electron.fsSaveCustomPresets(list);
  } else {
    safeSetItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  }
}

export async function saveCustomPreset(preset, options = {}) {
  const list = await loadCustomPresets();
  const now = new Date().toISOString();
  const normalizedPreset = normalizePresetRecord(preset);

  let idx = list.findIndex(p => normalizedPreset.id && p.id === normalizedPreset.id);
  if (idx < 0) {
    idx = list.findIndex(p => isSamePresetIdentity(p, normalizedPreset));
  }

  const existing = idx >= 0 ? list[idx] : null;
  const record = {
    ...existing,
    ...normalizedPreset,
    id: existing?.id || normalizedPreset.id || crypto.randomUUID(),
    source: 'custom',
    createdAt: existing?.createdAt || normalizedPreset.createdAt || now,
    updatedAt: now,
    modules: options.replaceModules
      ? { ...(normalizedPreset.modules || {}) }
      : {
          ...(existing?.modules || {}),
          ...(normalizedPreset.modules || {}),
        },
  };

  if (idx >= 0) {
    list[idx] = record;
  } else {
    list.push(record);
  }

  await saveCustomPresetsAll(list);
  return record;
}

export async function deleteCustomPreset(id) {
  const list = await loadCustomPresets();
  const filtered = list.filter(p => p.id !== id);
  await saveCustomPresetsAll(filtered);
  return filtered;
}

export function mergePresets(builtins, customs) {
  const result = builtins.map(b => ({
    ...b,
    modules: { ...(b.modules || {}) },
  }));

  for (const customPreset of customs) {
    const builtinIdx = result.findIndex(
      builtinPreset =>
        builtinPreset.source === 'builtin'
        && isSamePresetIdentity(builtinPreset, customPreset)
    );

    if (builtinIdx >= 0) {
      result[builtinIdx] = {
        ...result[builtinIdx],
        modules: {
          ...(result[builtinIdx].modules || {}),
          ...(customPreset.modules || {}),
        },
        _customId: customPreset.id,
        _customCategory: customPreset.category,
        _customDescription: customPreset.description,
      };
      continue;
    }

    result.push({
      ...customPreset,
      modules: { ...(customPreset.modules || {}) },
    });
  }

  return result;
}

export async function loadAllPresets() {
  let builtins = [];
  let builtinError = null;

  try {
    const res = await fetch('./job-presets.json');
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    builtins = (data.presets || []).map(normalizeBuiltinPreset);
  } catch (e) {
    builtinError = e;
  }

  const customs = await loadCustomPresets();
  if (builtinError && customs.length === 0) {
    throw builtinError;
  }

  return {
    merged: mergePresets(builtins, customs),
    builtinCount: builtins.length,
    customCount: customs.length,
    builtinError,
  };
}

function toExportableCustomPreset(preset) {
  if (!preset) return null;

  const customId = preset._customId || (preset.source === 'custom' ? preset.id : null);
  if (!customId) return null;

  return {
    id: customId,
    jobName: preset.jobName,
    category: getPresetCategory(preset) || DEFAULT_CATEGORY,
    description: getPresetDescription(preset),
    source: 'custom',
    createdAt: preset.createdAt || null,
    updatedAt: preset.updatedAt || null,
    modules: { ...(preset.modules || {}) },
  };
}

export function exportPresetsToJSON(presets) {
  const customPresets = (presets || [])
    .map(toExportableCustomPreset)
    .filter(Boolean);

  const data = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    presets: customPresets,
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `custom-presets-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function importPresetsFromJSON(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  const imported = data.presets || [];
  const existing = await loadCustomPresets();
  const existingIdentities = new Set(existing.map(buildPresetIdentity));
  const now = new Date().toISOString();
  let addedCount = 0;

  for (const preset of imported) {
    const normalizedPreset = normalizePresetRecord(preset);
    const identity = buildPresetIdentity(normalizedPreset);

    if (existingIdentities.has(identity)) continue;

    existing.push({
      id: crypto.randomUUID(),
      ...normalizedPreset,
      source: 'custom',
      createdAt: now,
      updatedAt: now,
    });
    existingIdentities.add(identity);
    addedCount++;
  }

  await saveCustomPresetsAll(existing);
  return { addedCount, totalCount: existing.length };
}
