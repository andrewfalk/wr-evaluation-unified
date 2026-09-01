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

  // 경추(목)
  { pattern: /^M50/i, moduleId: 'cervical', label: '경추(목)' },
  { pattern: /^M4802/i, moduleId: 'cervical', label: '경추(목)' },

  // 요추(허리)
  { pattern: /^M51/i, moduleId: 'spine', label: '요추(허리)' },
  { pattern: /^M54/i, moduleId: 'spine', label: '요추(허리)' },
  { pattern: /^M47/i, moduleId: 'spine', label: '요추(허리)' },
  { pattern: /^M4806/i, moduleId: 'spine', label: '요추(허리)' },
  { pattern: /^M53/i, moduleId: 'spine', label: '요추(허리)' },
];

const NAME_MODULE_MAP = [
  {
    pattern: /무릎|슬관절|족관절|발목|반월상|십자인대|관절경|슬개골/i,
    moduleId: 'knee',
    label: '무릎',
  },
  {
    pattern: /손목|손가락|완관절|척골|수근관|손목\s*터널|듀피트렌|뒤피트랑|Dupuytren|손바닥\s*섬유종증|손부위|드퀘르벵|방아쇠수지|방아쇠엄지|trigger\s*finger|trigger\s*thumb|de\s*quervain|tenosynovitis|tendovaginitis|carpal\s*tunnel|cts|guyon|ulnar\s*neuropathy\s*at\s*wrist|wrist\s*arthr|finger\s*arthr|hand\s*arthr|kienb[oö]ck|월상골/i,
    moduleId: 'wrist',
    label: '손목/손가락',
  },
  {
    pattern: /팔꿈치|외측\s*상과|내측\s*상과|상과염|테니스\s*엘보|골프\s*엘보|주관증후군|척골신경|점액낭염|진동성\s*팔꿈치|박리성\s*골연골염|부착부\s*건병증|삽입건병증/i,
    moduleId: 'elbow',
    label: '팔꿈치',
  },
  {
    pattern: /어깨|견관절|회전근개|견쇄관절|견쇄 관절|극상근|충돌증후군|석회성건염/i,
    moduleId: 'shoulder',
    label: '어깨',
  },
  {
    pattern: /경추|경추간판|목\s*디스크|cervical|경추협착|경추 협착|척수병증|목통증|목\s*통증/i,
    moduleId: 'cervical',
    label: '경추(목)',
  },
  {
    pattern: /요추|허리|허리통증|요통|lumbar|요추간판|요추협착|요추 협착|/i,
    moduleId: 'spine',
    label: '요추(허리)',
  },
];

/**
 * 단일 진단의 모듈 힌트를 반환
 * @returns {{ moduleId: string, label: string } | null}
 */
export function getDiagnosisModuleHint(diag) {
  const code = String(diag.code || '').trim().toUpperCase();
  const name = String(diag.name || '').trim();

  if (/^M48/i.test(code) || /^M47/i.test(code) || /^M54/i.test(code)) {
    if (/(경추|목|cervical)/i.test(name)) {
      return { moduleId: 'cervical', label: '경추(목)' };
    }
  }

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

// 코드는 점·공백을 제거하고 대문자로 비교(M17.0 / m170 / "M17.0 " 모두 매칭).
function normalizedCode(diag) {
  return String(diag?.code || '').replace(/[.\s]/g, '').toUpperCase();
}

// 상병명은 공백을 제거하고 비교("무릎 관절증" / "무릎관절증" / "슬관절 골관절염" 동일 취급).
function normalizedName(diag) {
  return String(diag?.name || '').replace(/\s/g, '');
}

// M17은 하위코드 전체가 무릎관절증(gonarthrosis)이다 — M17.0/M17.9뿐 아니라
// M17.1~M17.5(원발성·외상후·이차성 / 편측·양측)도 모두 K-L Grade 대상.
const KLG_CODE_PATTERN = /^M17/;
// 무릎·슬관절 + (조사 의) + (골|퇴행성) + 관절증|관절염 표기 변형을 모두 수용
// (무릎관절증 / 무릎의 관절증 / 무릎 관절염 / 슬관절염 / 퇴행성 슬관절 골관절염 ...).
const KLG_NAME_PATTERN = /(무릎|슬관절|슬)의?(골|퇴행성)?관절(증|염)/;
const KLG_NAME_EN_PATTERN = /gonarthrosis|knee\s*(osteo)?arthr|(osteo)?arthr\w*\s+of\s+(the\s+)?knee/i;
const ELLMAN_CODE_PATTERN = /^M751/;
const ELLMAN_NAME_PATTERN = /회전근개\s*증후군|회전근개\s*파열/;

// 무릎 상병 중 K-L Grade 입력이 필요한 것(M17 하위코드 전체 또는 무릎·슬관절
// 관절증·관절염 표기)만 true. 조건 미충족 상병은 입력창만 숨기고 기존
// klgRight/klgLeft 값은 그대로 보존한다.
export function supportsKlGrade(diag) {
  return KLG_CODE_PATTERN.test(normalizedCode(diag))
    || KLG_NAME_PATTERN.test(normalizedName(diag))
    || KLG_NAME_EN_PATTERN.test(String(diag?.name || ''));
}

// 어깨 상병 중 Ellman Class 입력이 필요한 것(M751 또는 회전근개 증후군·회전근개 파열)만 true.
export function supportsEllmanClass(diag) {
  return ELLMAN_CODE_PATTERN.test(normalizedCode(diag)) || ELLMAN_NAME_PATTERN.test(diag?.name || '');
}

export const MODULE_LABELS = {
  knee: '무릎',
  wrist: '손목/손가락',
  elbow: '팔꿈치',
  shoulder: '어깨',
  spine: '요추(허리)',
  cervical: '경추(목)',
};

export function isValidDiagnosisModuleId(id) {
  // Object.hasOwn은 ES2022(Chrome 93+)라 윈도7 구형 크롬에서 미지원 → 흰 화면 유발.
  // 호환을 위해 Object.prototype.hasOwnProperty.call 사용.
  return !!id && id !== '__none__' && Object.prototype.hasOwnProperty.call(MODULE_LABELS, id);
}

/**
 * 진단과 직접 매핑되지 않을 때 활성 모듈이 1개면 그 모듈로 해석
 * @returns {{ moduleId: string, label: string } | null}
 */
export function resolveDiagnosisModule(diag, activeModules = []) {
  if (diag?.moduleId === '__none__') return null;
  if (isValidDiagnosisModuleId(diag?.moduleId)) {
    const moduleId = diag.moduleId;
    return { moduleId, label: MODULE_LABELS[moduleId] };
  }

  const hint = getDiagnosisModuleHint(diag);
  if (hint) return hint;

  const candidates = (activeModules || []).filter(isValidDiagnosisModuleId);
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
    const hint = resolveDiagnosisModule(diag, []);
    if (hint) suggested.add(hint.moduleId);
  }
  return Array.from(suggested);
}
