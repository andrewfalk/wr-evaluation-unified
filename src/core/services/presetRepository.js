// 프리셋 저장소: builtin(JSON) + custom(localStorage/Electron FS) 통합 관리

const CUSTOM_PRESETS_KEY = 'wrEvalUnifiedCustomPresets';

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
// builtin 프리셋 정규화
// ======================================================

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

// ======================================================
// custom 프리셋 CRUD (localStorage / Electron FS)
// ======================================================

export async function loadCustomPresets() {
  if (isElectronFS() && window.electron.fsLoadCustomPresets) {
    const presets = await window.electron.fsLoadCustomPresets();
    return presets || [];
  }
  const raw = localStorage.getItem(CUSTOM_PRESETS_KEY);
  if (raw) {
    try { return JSON.parse(raw); }
    catch { localStorage.removeItem(CUSTOM_PRESETS_KEY); }
  }
  return [];
}

async function saveCustomPresetsAll(list) {
  if (isElectronFS() && window.electron.fsSaveCustomPresets) {
    await window.electron.fsSaveCustomPresets(list);
  } else {
    safeSetItem(CUSTOM_PRESETS_KEY, JSON.stringify(list));
  }
}

export async function saveCustomPreset(preset) {
  const list = await loadCustomPresets();
  const now = new Date().toISOString();
  // id 매칭 또는 동일 jobName 매칭 (중복 방지)
  let idx = list.findIndex(p => preset.id && p.id === preset.id);
  if (idx < 0) {
    idx = list.findIndex(p => p.jobName === preset.jobName);
  }
  const record = {
    ...preset,
    source: 'custom',
    updatedAt: now,
    createdAt: (idx >= 0 ? list[idx].createdAt : null) || preset.createdAt || now,
  };
  if (idx >= 0) {
    record.id = list[idx].id;
    list[idx] = record;
  } else {
    record.id = record.id || crypto.randomUUID();
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

// ======================================================
// 병합: builtin + custom
// ======================================================

export function mergePresets(builtins, customs) {
  const result = builtins.map(b => ({ ...b }));
  for (const c of customs) {
    // custom이 builtin의 동일 jobName을 보충하는 경우
    const builtinIdx = result.findIndex(
      b => b.source === 'builtin' && b.jobName === c.jobName
    );
    if (builtinIdx >= 0) {
      result[builtinIdx] = {
        ...result[builtinIdx],
        modules: { ...result[builtinIdx].modules, ...c.modules },
        _customId: c.id,
      };
    } else {
      result.push({ ...c });
    }
  }
  return result;
}

// ======================================================
// 통합 로드
// ======================================================

export async function loadAllPresets() {
  let builtins = [];
  try {
    const res = await fetch('./job-presets.json');
    if (!res.ok) throw new Error('Not found');
    const data = await res.json();
    builtins = (data.presets || []).map(normalizeBuiltinPreset);
  } catch {
    // fallback은 호출 측에서 처리
  }
  const customs = await loadCustomPresets();
  return { merged: mergePresets(builtins, customs), builtinCount: builtins.length, customCount: customs.length };
}

// ======================================================
// 내보내기 / 가져오기
// ======================================================

export function exportPresetsToJSON(presets) {
  const data = {
    version: '2.0.0',
    exportedAt: new Date().toISOString(),
    presets: presets.filter(p => p.source === 'custom'),
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
  const existingNames = new Set(existing.map(p => p.jobName));
  const now = new Date().toISOString();
  let addedCount = 0;
  for (const p of imported) {
    if (!existingNames.has(p.jobName)) {
      existing.push({ ...p, id: crypto.randomUUID(), source: 'custom', createdAt: now, updatedAt: now });
      existingNames.add(p.jobName);
      addedCount++;
    }
  }
  await saveCustomPresetsAll(existing);
  return { addedCount, totalCount: existing.length };
}
