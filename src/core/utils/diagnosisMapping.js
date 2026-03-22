// 상병 코드/이름 → 평가 모듈 자동 매핑

const ICD_MODULE_MAP = [
  // 무릎 (슬관절)
  { pattern: /^M17/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /^M22/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /^M23/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /^M70\.4/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /^M76\.5/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /^S83/i, moduleId: 'knee', label: '무릎(슬관절)' },

  // 척추 (요추)
  { pattern: /^M51/i, moduleId: 'spine', label: '척추(요추)' },
  { pattern: /^M54/i, moduleId: 'spine', label: '척추(요추)' },
  { pattern: /^M47/i, moduleId: 'spine', label: '척추(요추)' },
  { pattern: /^M48/i, moduleId: 'spine', label: '척추(요추)' },
  { pattern: /^M50/i, moduleId: 'spine', label: '척추(요추)' },
  { pattern: /^M53/i, moduleId: 'spine', label: '척추(요추)' },
];

const NAME_MODULE_MAP = [
  { pattern: /슬관절|무릎|반월상|십자인대|측부인대|관절경|슬개골/i, moduleId: 'knee', label: '무릎(슬관절)' },
  { pattern: /요추|척추|추간판|디스크|협착증|전방전위증|척추관|요통|경추/i, moduleId: 'spine', label: '척추(요추)' },
];

/**
 * 단일 상병의 모듈 힌트 반환
 * @returns {{ moduleId: string, label: string } | null}
 */
export function getDiagnosisModuleHint(diag) {
  if (diag.code) {
    for (const rule of ICD_MODULE_MAP) {
      if (rule.pattern.test(diag.code)) return { moduleId: rule.moduleId, label: rule.label };
    }
  }
  if (diag.name) {
    for (const rule of NAME_MODULE_MAP) {
      if (rule.pattern.test(diag.name)) return { moduleId: rule.moduleId, label: rule.label };
    }
  }
  return null;
}

/**
 * 상병 배열로부터 추천 모듈 ID 목록 반환
 * @returns {string[]}
 */
export function suggestModules(diagnoses) {
  const suggested = new Set();
  for (const diag of diagnoses) {
    const hint = getDiagnosisModuleHint(diag);
    if (hint) suggested.add(hint.moduleId);
  }
  return Array.from(suggested);
}
