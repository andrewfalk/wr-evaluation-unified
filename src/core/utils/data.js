// 공통 데이터 생성 함수

// 생년월일을 YYYY-MM-DD 형식으로 정규화
export const formatBirthDate = (birthDate) => {
  if (!birthDate) return '-';

  // 이미 YYYY-MM-DD 형식이면 그대로 반환
  if (birthDate.includes('-')) return birthDate;

  // YYYYMMDD 형식을 YYYY-MM-DD로 변환
  if (birthDate.length === 8 && /^\d{8}$/.test(birthDate)) {
    return `${birthDate.slice(0, 4)}-${birthDate.slice(4, 6)}-${birthDate.slice(6, 8)}`;
  }

  // 기타 형식은 그대로 반환
  return birthDate;
};

export const createDiagnosis = () => ({
  id: crypto.randomUUID(),
  code: '',
  name: '',
  moduleId: null,
  side: ''
});

export const createSharedJob = () => ({
  id: crypto.randomUUID(),
  jobName: '',
  presetId: null,
  startDate: '',
  endDate: '',
  workPeriodOverride: '',
  workDaysPerYear: 250,
});

// 작업 영상 인간공학 분석 데이터(§8.11). 환자 JSONB(영구·UI용) — 임시파일 경로 절대 미포함.
// shape는 shared/contracts VideoAnalysisDataSchema.parse({})와 일치해야 한다(테스트로 강제).
export const createVideoAnalysisData = () => ({
  processes: [],          // 공정 메타(name, shiftSharePercent 등)
  clips: [],              // 클립 메타데이터만 — 파일 경로 저장 금지
  processFeatures: [],    // 공정 단위 fused feature
  jobFeatures: [],        // 직업 단위 집계(파생값)
  candidateFeatures: [],  // 자동입력 금지 후보(진동·회전 등)
  appliedInputs: [],      // provenance
  settings: { retentionMode: 'privacy_first' },
});

export const createSharedData = () => ({
  patientNo: '',
  name: '',
  gender: '',
  height: '',
  weight: '',
  birthDate: '',
  injuryDate: '',
  hospitalName: '근로복지공단 안산병원',
  department: '직업환경의학과',
  doctorName: '김호길',
  evaluationDate: '',
  medicalRecord: '',
  highBloodPressure: '',
  diabetes: '',
  visitHistory: '',
  consultReplyOrtho: '',
  consultReplyNeuro: '',
  consultReplyRehab: '',
  consultReplyOther: '',
  specialNotes: '',
  diagnoses: [createDiagnosis()],
  jobs: [createSharedJob()],
  videoAnalysis: createVideoAnalysisData(),
});

// 신형식: 다중 모듈 지원
export const createPatient = (activeModules = [], modulesData = {}) => ({
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  phase: activeModules.length > 0 ? 'evaluation' : 'intake',
  data: {
    shared: createSharedData(),
    modules: modulesData,
    activeModules
  }
});

// 구형식 → 신형식 마이그레이션
export function migratePatient(patient) {
  if (!patient || typeof patient !== 'object') return patient;
  if (patient.redacted === true) return patient;
  // createdAt 마이그레이션: 없으면 폴백
  let p = patient;
  if (!p.createdAt) {
    p = { ...p, createdAt: p.data?.shared?.evaluationDate || new Date(Date.now() - 86400000).toISOString() };
  }

  let migrated;
  // 이미 신형식이면 그대로 (jobs 마이그레이션도 체크)
  if (p.data?.modules && p.data?.activeModules) {
    migrated = migrateJobsToShared(p);
  } else if (p.moduleId && p.data?.module !== undefined) {
    // 구형식: moduleId + data.module → 신형식
    migrated = migrateJobsToShared({
      ...p,
      phase: 'evaluation',
      data: {
        shared: p.data.shared,
        modules: { [p.moduleId]: p.data.module },
        activeModules: [p.moduleId]
      }
    });
  } else {
    migrated = migrateJobsToShared(p);
  }

  // migrateJobsToShared는 shared.jobs가 이미 있으면 조기 반환하므로(신형식 환자),
  // 누락 shared 기본값(jobs·videoAnalysis)은 여기서 항상 보강한다.
  return ensureSharedDefaults(migrated);
}

// shared 누락 기본값 보강(조기 반환 경로 무관, 신형식 환자에도 적용).
// 기존 데이터는 보존하고 빠진 키만 채운다.
export function ensureSharedDefaults(patient) {
  if (!patient?.data || typeof patient.data !== 'object') return patient;
  const shared = { ...(patient.data.shared || {}) };
  let changed = false;
  if (!Array.isArray(shared.jobs)) {
    shared.jobs = [createSharedJob()];
    changed = true;
  }
  // videoAnalysis는 없거나(undefined) 부분 객체({})여도 빠진 키를 채운다 —
  // 하위(PR3/PR4)에서 processes·clips·appliedInputs 배열 존재를 가정하므로.
  const defaults = createVideoAnalysisData();
  const cur = shared.videoAnalysis;
  if (!cur || typeof cur !== 'object') {
    shared.videoAnalysis = defaults;
    changed = true;
  } else {
    const needsFill =
      Object.keys(defaults).some(k => cur[k] === undefined) ||
      typeof cur.settings !== 'object' || cur.settings === null ||
      cur.settings.retentionMode === undefined;
    if (needsFill) {
      shared.videoAnalysis = {
        ...defaults,
        ...cur,
        settings: { ...defaults.settings, ...(cur.settings || {}) },
      };
      changed = true;
    }
  }
  if (!changed) return patient;
  return { ...patient, data: { ...patient.data, shared } };
}

// jobs를 shared로 이동하는 마이그레이션
function migrateJobsToShared(patient) {
  if (!patient?.data || typeof patient.data !== 'object') return patient;
  if (patient.data.shared?.jobs) return patient; // 이미 마이그레이션됨

  const shared = { ...(patient.data.shared || {}), jobs: [] };
  const modules = { ...patient.data.modules };

  // 무릎 모듈에서 jobs 마이그레이션
  if (modules.knee?.jobs?.length) {
    const kneeExtras = [];
    for (const kneeJob of modules.knee.jobs) {
      const sharedJob = createSharedJob();
      sharedJob.id = kneeJob.id || sharedJob.id;
      sharedJob.jobName = kneeJob.jobName || '';
      sharedJob.presetId = kneeJob.presetId || null;
      sharedJob.startDate = kneeJob.startDate || '';
      sharedJob.endDate = kneeJob.endDate || '';
      sharedJob.workPeriodOverride = kneeJob.workPeriodOverride || '';
      shared.jobs.push(sharedJob);

      kneeExtras.push({
        sharedJobId: sharedJob.id,
        weight: kneeJob.weight || '',
        squatting: kneeJob.squatting || '',
        evidenceSources: kneeJob.evidenceSources || [],
        stairs: kneeJob.stairs || false,
        kneeTwist: kneeJob.kneeTwist || false,
        startStop: kneeJob.startStop || false,
        tightSpace: kneeJob.tightSpace || false,
        kneeContact: kneeJob.kneeContact || false,
        jumpDown: kneeJob.jumpDown || false,
      });
    }
    modules.knee = { ...modules.knee, jobExtras: kneeExtras };
    delete modules.knee.jobs;
  }

  // 척추 모듈에서 직업 필드 마이그레이션
  if (modules.spine && (modules.spine.jobName !== undefined || modules.spine.careerYears !== undefined)) {
    const spineJobName = modules.spine.jobName || '';
    const y = modules.spine.careerYears || 0;
    const m = modules.spine.careerMonths || 0;
    const wdpy = modules.spine.workDaysPerYear || 250;

    // 이미 무릎에서 shared.jobs가 만들어졌으면 첫 번째 job에 workDaysPerYear 적용
    if (shared.jobs.length > 0) {
      shared.jobs[0].workDaysPerYear = wdpy;
      // 척추에 다른 직업명이 있고 shared.jobs에 없으면 추가
      if (spineJobName && !shared.jobs.find(j => j.jobName === spineJobName)) {
        const extraJob = createSharedJob();
        extraJob.jobName = spineJobName;
        extraJob.workDaysPerYear = wdpy;
        if (y || m) extraJob.workPeriodOverride = `${y}년 ${m}개월`;
        shared.jobs.push(extraJob);
      }
    } else {
      // 척추만 있는 경우
      const spineJob = createSharedJob();
      spineJob.jobName = spineJobName;
      spineJob.workDaysPerYear = wdpy;
      if (y || m) spineJob.workPeriodOverride = `${y}년 ${m}개월`;
      shared.jobs.push(spineJob);
    }

    // 척추 모듈에서 직업 필드 제거
    const { jobName, careerYears, careerMonths, workDaysPerYear, ...restSpine } = modules.spine;
    modules.spine = restSpine;
  }

  // 최소 1개 job 보장
  if (shared.jobs.length === 0) {
    shared.jobs.push(createSharedJob());
  }

  return { ...patient, data: { ...patient.data, shared, modules } };
}

// 환자 배열 일괄 마이그레이션
export function migratePatients(patients) {
  return patients.map(migratePatient);
}

// 예시 환자 데이터 (튜토리얼/테스트용)
export function createSamplePatient() {
  const jobId1 = crypto.randomUUID();
  const jobId2 = crypto.randomUUID();

  return {
    id: crypto.randomUUID(),
    phase: 'evaluation',
    data: {
      shared: {
        patientNo: 'SAMPLE-0001',
        name: '홍길동(예시)',
        gender: 'male',
        height: '175',
        weight: '78',
        birthDate: '1970-03-15',
        injuryDate: '2024-06-01',
        evaluationDate: '2024-12-15',
        hospitalName: '근로복지공단 안산병원',
        department: '직업환경의학과',
        doctorName: '김호길',
        specialNotes: '고혈압 약 복용 중. 2024년 3월경부터 무릎 통증 및 요통 호소.',
        diagnoses: [
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증 우측', side: 'right' },
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증 좌측', side: 'left' },
          { id: crypto.randomUUID(), code: 'M51.1', name: '요추간판장애(요추 추간판탈출증)', side: '' },
        ],
        jobs: [
          {
            id: jobId1,
            jobName: '건설 현장 배근공',
            presetId: null,
            startDate: '2000-03-01',
            endDate: '2018-12-31',
            workPeriodOverride: '',
            workDaysPerYear: 250,
          },
          {
            id: jobId2,
            jobName: '물류 창고 하역작업원',
            presetId: null,
            startDate: '2019-02-01',
            endDate: '2024-06-01',
            workPeriodOverride: '',
            workDaysPerYear: 280,
          },
        ],
        videoAnalysis: {
          ...createVideoAnalysisData(),
          processes: [
            { id: 'sample-proc-1', sharedJobId: jobId1, name: '철근 배근', shiftSharePercent: 60 },
          ],
        },
      },
      modules: {
        knee: {
          jobExtras: [
            {
              sharedJobId: jobId1,
              weight: '3200',
              squatting: '200',
              evidenceSources: [],
              stairs: true,
              kneeTwist: true,
              startStop: false,
              tightSpace: true,
              kneeContact: true,
              jumpDown: false,
            },
            {
              sharedJobId: jobId2,
              weight: '2800',
              squatting: '120',
              evidenceSources: [],
              stairs: false,
              kneeTwist: false,
              startStop: true,
              tightSpace: false,
              kneeContact: false,
              jumpDown: true,
            },
          ],
          returnConsiderations: '무거운 중량물 취급 제한 권고. 쪼그려 앉는 작업 회피 필요. 무릎 보호대 착용 권장.',
        },
        spine: {
          formulaVersion: 'v5.1.3',
          tasks: [
            {
              id: Date.now() + 1,
              name: '시멘트 포대 들기',
              posture: 'G3',
              weight: 25,
              frequency: 60,
              timeValue: 5,
              timeUnit: 'sec',
              correctionFactor: 1.0,
              force: 0,
            },
            {
              id: Date.now() + 2,
              name: '철근 자재 운반',
              posture: 'G7',
              weight: 30,
              frequency: 40,
              timeValue: 15,
              timeUnit: 'sec',
              correctionFactor: 1.0,
              force: 0,
            },
            {
              id: Date.now() + 3,
              name: '거푸집 조립 (비대칭)',
              posture: 'G5',
              weight: 20,
              frequency: 30,
              timeValue: 8,
              timeUnit: 'sec',
              correctionFactor: 1.9,
              force: 0,
            },
            {
              id: Date.now() + 4,
              name: '박스 하역 (허리 굽혀)',
              posture: 'G4',
              weight: 15,
              frequency: 100,
              timeValue: 4,
              timeUnit: 'sec',
              correctionFactor: 1.0,
              force: 0,
            },
            {
              id: Date.now() + 5,
              name: '자재 어깨 운반',
              posture: 'G9',
              weight: 35,
              frequency: 20,
              timeValue: 30,
              timeUnit: 'sec',
              correctionFactor: 1.0,
              force: 0,
            },
          ],
        },
      },
      activeModules: ['knee', 'spine'],
    },
  };
}

// 설정 기본값
const DEFAULT_INTEGRATION_MODE =
  import.meta.env.VITE_DEFAULT_INTEGRATION_MODE === 'intranet'
    ? 'intranet'
    : 'local';

export const DEFAULT_SETTINGS = {
  theme: 'light',
  fontSize: 'medium',
  hospitalName: '근로복지공단 안산병원',
  department: '직업환경의학과',
  doctorName: '김호길',
  autoSaveInterval: 30,
  integrationMode: DEFAULT_INTEGRATION_MODE,
  apiBaseUrl: ''
};

export const FONT_SIZE_MAP = {
  small: '14px',
  medium: '16px',
  large: '18px'
};
