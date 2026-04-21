// 진단 코드/이름 기반 평가 모듈 자동 매핑

const ICD_MODULE_MAP = [
  // 무릎
  { pattern: /^M17/i, moduleId: 'knee', label: '무릎' },
  { pattern: /^M22/i, moduleId: 'knee', label: '무릎' },
  { pattern: /^M23/i, moduleId: 'knee', label: '무릎' },
  { pattern: /^M704/i, moduleId: 'knee', label: '무릎' },
  { pattern: /^M765/i, moduleId: 'knee', label: '무릎' },
  { pattern: /^S83/i, moduleId: 'knee', label: '무릎' },

  // 손목/손가락
  { pattern: /^G560/i, moduleId: 'wrist', label: '손목/손가락' },
  { pattern: /^M653/i, moduleId: 'wrist', label: '손목/손가락' },
  { pattern: /^M654/i, moduleId: 'wrist', label: '손목/손가락' },
  { pattern: /^M720/i, moduleId: 'wrist', label: '손목/손가락' },

  // 팔꿈치
  { pattern: /^M770/i, moduleId: 'elbow', label: '팔꿈치' },
  { pattern: /^M771/i, moduleId: 'elbow', label: '팔꿈치' },
  { pattern: /^T752/i, moduleId: 'elbow', label: '팔꿈치' },

  // 어깨
  { pattern: /^M75/i, moduleId: 'shoulder', label: '어깨' },
  { pattern: /^M1901/i, moduleId: 'shoulder', label: '어깨' },
  { pattern: /^S43/i, moduleId: 'shoulder', label: '어깨' },
  { pattern: /^S46/i, moduleId: 'shoulder', label: '어깨' },

  // 척추
  { pattern: /^M51/i, moduleId: 'spine', label: '척추' },
  { pattern: /^M54/i, moduleId: 'spine', label: '척추' },
  { pattern: /^M47/i, moduleId: 'spine', label: '척추' },
  { pattern: /^M48/i, moduleId: 'spine', label: '척추' },
  { pattern: /^M50/i, moduleId: 'spine', label: '척추' },
  { pattern: /^M53/i, moduleId: 'spine', label: '척추' },
];

const NAME_MODULE_MAP = [
  {
    pattern: /무릎|슬관절|반월상|십자인대|관절경|슬개골/i,
    moduleId: 'knee',
    label: '무릎',
  },
  {
    pattern: /손목|손가락|수근관|손목\s*터널|듀피트렌|뒤피트랑|Dupuytren|손바닥\s*섬유종증|손부위|드퀘르벵|방아쇠수지|방아쇠엄지|trigger\s*finger|trigger\s*thumb|de\s*quervain|tenosynovitis|tendovaginitis|carpal\s*tunnel|cts|guyon|ulnar\s*neuropathy\s*at\s*wrist|wrist\s*arthr|finger\s*arthr|hand\s*arthr|kienb[oö]ck|월상골/i,
    moduleId: 'wrist',
    label: '손목/손가락',
  },
  {
    pattern: /팔꿈치|외측\s*상과|내측\s*상과|상과염|테니스\s*엘보|골프\s*엘보|주관증후군|척골신경|점액낭염|진동성\s*팔꿈치|박리성\s*골연골염|부착부\s*건병증|삽입건병증/i,
    moduleId: 'elbow',
    label: '팔꿈치',
  },
  {
    pattern: /어깨|견관절|회전근개|극상근|충돌증후군|석회성건염/i,
    moduleId: 'shoulder',
    label: '어깨',
  },
  {
    pattern: /요추|척추|추간판|디스크|경추|허리통증/i,
    moduleId: 'spine',
    label: '척추',
  },
];

/**
 * 단일 진단의 모듈 힌트를 반환
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

const MODULE_LABELS = {
  knee: '무릎',
  wrist: '손목/손가락',
  elbow: '팔꿈치',
  shoulder: '어깨',
  spine: '척추',
};

/**
 * 진단과 직접 매핑되지 않을 때 활성 모듈이 1개면 그 모듈로 해석
 * @returns {{ moduleId: string, label: string } | null}
 */
export function resolveDiagnosisModule(diag, activeModules = []) {
  const hint = getDiagnosisModuleHint(diag);
  if (hint) return hint;

  const candidates = (activeModules || []).filter(moduleId => Object.hasOwn(MODULE_LABELS, moduleId));
  if (candidates.length !== 1) return null;

  const moduleId = candidates[0];
  return { moduleId, label: MODULE_LABELS[moduleId] };
}

/**
 * 진단 배열에서 추천 모듈 목록 반환
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
