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
  // createdAt 마이그레이션: 없으면 폴백
  let p = patient;
  if (!p.createdAt) {
    p = { ...p, createdAt: p.data?.shared?.evaluationDate || new Date(Date.now() - 86400000).toISOString() };
  }

  // 이미 신형식이면 그대로
  if (p.data.modules && p.data.activeModules) {
    // jobs 마이그레이션도 체크
    return migrateJobsToShared(p);
  }
  // 구형식: moduleId + data.module → 신형식
  if (p.moduleId && p.data.module !== undefined) {
    const migrated = {
      ...p,
      phase: 'evaluation',
      data: {
        shared: p.data.shared,
        modules: { [p.moduleId]: p.data.module },
        activeModules: [p.moduleId]
      }
    };
    return migrateJobsToShared(migrated);
  }
  return migrateJobsToShared(p);
}

// jobs를 shared로 이동하는 마이그레이션
function migrateJobsToShared(patient) {
  if (patient.data.shared?.jobs) return patient; // 이미 마이그레이션됨

  const shared = { ...patient.data.shared, jobs: [] };
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
export const DEFAULT_SETTINGS = {
  theme: 'light',
  fontSize: 'medium',
  hospitalName: '근로복지공단 안산병원',
  department: '직업환경의학과',
  doctorName: '김호길',
  autoSaveInterval: 30,
  integrationMode: 'local',
  apiBaseUrl: ''
};

export const FONT_SIZE_MAP = {
  small: '14px',
  medium: '16px',
  large: '18px'
};

// 테스트용 대량 환자 데이터 (대시보드 차트 테스트)
function createTestPatientsLegacy() {
  const testPatients = [];

  // 지난 6개월 동안 분포된 등록 및 평가 완료 날짜

  // 테스트 환자 데이터 (16명)
  // evaluationDate는 종합소견 완성 환자(idx 0, 3, 7)만 설정
  const testData = [
    // 2025년 10월 등록
    { createdAt: '2025-10-05', evaluationDate: '2025-10-20', modules: ['knee'] },         // idx 0: 완성
    { createdAt: '2025-10-08', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2025-10-15', evaluationDate: '', modules: ['spine'] },

    // 2025년 11월 등록
    { createdAt: '2025-11-03', evaluationDate: '2025-11-18', modules: ['knee'] },         // idx 3: 완성
    { createdAt: '2025-11-10', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2025-11-22', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2025-11-28', evaluationDate: '', modules: ['knee'] },

    // 2025년 12월 등록
    { createdAt: '2025-12-02', evaluationDate: '2025-12-15', modules: ['knee', 'spine'] },// idx 7: 완성
    { createdAt: '2025-12-12', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2025-12-20', evaluationDate: '', modules: ['knee'] },

    // 2026년 1월 등록
    { createdAt: '2026-01-05', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2026-01-14', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2026-01-28', evaluationDate: '', modules: ['spine'] },

    // 2026년 2월 등록
    { createdAt: '2026-02-08', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2026-02-18', evaluationDate: '', modules: ['knee', 'spine'] },

    // 2026년 3월 등록
    { createdAt: '2026-03-05', evaluationDate: '', modules: ['spine'] },
  ];

  // 환자 이름 목록 (한국식)
  const names = [
    '김철수', '이영미', '박준호', '최진영', '정수현',
    '손민준', '조현희', '윤상훈', '강미영', '허진혁',
    '배경윤', '송다연', '임효진', '유승재', '문형준', '황미라'
  ];

  testData.forEach((data, idx) => {
    const patient = createPatient(data.modules, {});

    // createdAt 설정
    patient.createdAt = `${data.createdAt}T09:${String(idx * 4 % 60).padStart(2, '0')}:00.000Z`;

    // 공유 데이터 설정
    patient.data.shared.name = names[idx];
    patient.data.shared.gender = idx % 2 === 0 ? 'male' : 'female';
    patient.data.shared.height = String(160 + Math.floor(idx / 2) % 15);
    patient.data.shared.weight = String(60 + Math.floor(idx / 2) % 20);
    const birthYear = 1960 + idx;
    const birthMonth = String((idx % 12) + 1).padStart(2, '0');
    patient.data.shared.birthDate = `${birthYear}-${birthMonth}-15`;
    patient.data.shared.injuryDate = data.createdAt;
    patient.data.shared.evaluationDate = data.evaluationDate;
    patient.data.shared.specialNotes = idx % 3 === 0 ? '기타 질환 없음' : '';
    patient.phase = data.evaluationDate ? 'evaluation' : 'evaluation';

    // 상병 데이터 생성 (인덱스 0, 3, 7은 종합소견 완성)
    const isCompleteCase = [0, 3, 7].includes(idx);
    const diagnoses = [];
    if (data.modules.includes('knee')) {
      if (isCompleteCase && idx === 3) {
        // 환자 3: 우측 high, 좌측 low (사유 포함)
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'right',
            confirmedRight: 'confirmed', assessmentRight: 'high', klgRight: '3' },
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'left',
            confirmedLeft: 'confirmed', assessmentLeft: 'low', klgLeft: '2',
            reasonLeft: ['mild', 'lowBurden'], reasonLeftOther: '' }
        );
      } else if (isCompleteCase) {
        // 환자 0, 7: 양측 모두 confirmed + high
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'right',
            confirmedRight: 'confirmed', assessmentRight: 'high', klgRight: '3' },
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'left',
            confirmedLeft: 'confirmed', assessmentLeft: 'high', klgLeft: '2' }
        );
      } else {
        // 미완성 환자: 기본 상병만
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'right' },
          { id: crypto.randomUUID(), code: 'M17.1', name: '원발성 무릎관절증', side: 'left' }
        );
      }
    }
    if (data.modules.includes('spine')) {
      if (isCompleteCase) {
        // 완성 환자: 척추 상병 확인 + 업무관련성 높음
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M51.1', name: '요추간판장애', side: '',
            confirmedRight: 'confirmed', assessmentRight: 'high' }
        );
      } else {
        // 미완성 환자: 기본 상병만
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M51.1', name: '요추간판장애', side: '' }
        );
      }
    }
    // 최소 1개 상병 보장
    if (diagnoses.length === 0) {
      diagnoses.push({ id: crypto.randomUUID(), code: 'M79.3', name: '근육통', side: '' });
    }
    patient.data.shared.diagnoses = diagnoses;

    // shared.jobs 생성 (2개)
    const job1Id = crypto.randomUUID();
    const job2Id = crypto.randomUUID();
    patient.data.shared.jobs = [
      {
        id: job1Id,
        jobName: idx % 2 === 0 ? '건설 현장 배근공' : '운송 운전원',
        presetId: null,
        startDate: `${1995 + idx}-01-01`,
        endDate: `${2015 + idx}-12-31`,
        workPeriodOverride: '',
        workDaysPerYear: 250,
      },
      {
        id: job2Id,
        jobName: idx % 3 === 0 ? '물류 창고 하역' : '제조업 생산직',
        presetId: null,
        startDate: `${2016 + idx}-01-01`,
        endDate: `${data.createdAt.slice(0, 4)}-12-31`,
        workPeriodOverride: '',
        workDaysPerYear: 260,
      },
    ];

    // 각 모듈별 초기 데이터
    if (data.modules.includes('knee')) {
      // 종합 소견: 완성 대상 3명(0, 3, 7)만 작성
      const returnConsiderationsMap = {
        0: '무거운 물건 취급 제한. 쪼그려 앉는 작업 회피 필요.',
        3: '계단 오르내리기 제한 권고. 무릎 보호대 착용 필수.',
        7: '중량물 취급 및 장시간 서있는 작업 제한. 슬관절 및 요추 부담 작업 회피 권고.',
      };

      patient.data.modules.knee = {
        jobExtras: [
          {
            sharedJobId: job1Id,
            weight: String(2000 + idx * 100),
            squatting: String(50 + idx * 10),
            evidenceSources: [],
            stairs: idx % 2 === 0,
            kneeTwist: idx % 3 === 0,
            startStop: idx % 4 === 0,
            tightSpace: idx % 5 === 0,
            kneeContact: idx % 2 === 1,
            jumpDown: idx % 6 === 0,
          },
          {
            sharedJobId: job2Id,
            weight: String(1500 + idx * 80),
            squatting: String(30 + idx * 8),
            evidenceSources: [],
            stairs: idx % 3 === 0,
            kneeTwist: idx % 2 === 0,
            startStop: idx % 5 === 0,
            tightSpace: idx % 4 === 0,
            kneeContact: idx % 3 === 1,
            jumpDown: idx % 7 === 0,
          },
        ],
        returnConsiderations: returnConsiderationsMap[idx] || '',
      };
    }

    if (data.modules.includes('spine')) {
      const taskNames = ['시멘트 포대 들기', '철근 자재 운반', '거푸집 조립', '박스 하역', '자재 어깨 운반'];
      const postures = ['G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9'];

      patient.data.modules.spine = {
        tasks: [
          {
            id: Date.now() + idx * 10,
            name: taskNames[idx % 5],
            posture: postures[idx % 7],
            weight: 20 + idx,
            frequency: 30 + idx * 2,
            timeValue: 5,
            timeUnit: 'sec',
            correctionFactor: 1.0 + (idx % 5) * 0.2,
            force: 0,
          },
          {
            id: Date.now() + idx * 10 + 1,
            name: taskNames[(idx + 1) % 5],
            posture: postures[(idx + 1) % 7],
            weight: 25 + idx,
            frequency: 40 + idx,
            timeValue: 8,
            timeUnit: 'sec',
            correctionFactor: 1.0 + ((idx + 1) % 5) * 0.2,
            force: 0,
          },
          {
            id: Date.now() + idx * 10 + 2,
            name: taskNames[(idx + 2) % 5],
            posture: postures[(idx + 2) % 7],
            weight: 15 + idx,
            frequency: 50 + idx * 2,
            timeValue: 6,
            timeUnit: 'sec',
            correctionFactor: 1.0 + ((idx + 2) % 5) * 0.2,
            force: 0,
          },
        ],
      };
    }

    testPatients.push(patient);
  });

  return testPatients;
}

export function createTestPatients() {
  const testPatients = [];

  const testData = [
    { createdAt: '2025-10-05', evaluationDate: '2025-10-20', modules: ['knee'] },
    { createdAt: '2025-10-08', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2025-10-15', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2025-11-03', evaluationDate: '2025-11-18', modules: ['knee'] },
    { createdAt: '2025-11-10', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2025-11-22', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2025-11-28', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2025-12-02', evaluationDate: '2025-12-15', modules: ['knee', 'spine'] },
    { createdAt: '2025-12-12', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2025-12-20', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2026-01-05', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2026-01-14', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2026-01-28', evaluationDate: '', modules: ['spine'] },
    { createdAt: '2026-02-08', evaluationDate: '', modules: ['knee'] },
    { createdAt: '2026-02-18', evaluationDate: '', modules: ['knee', 'spine'] },
    { createdAt: '2026-03-05', evaluationDate: '', modules: ['spine'] },

    { createdAt: '2025-10-24', evaluationDate: '2025-11-04', modules: ['shoulder'] },
    { createdAt: '2025-11-16', evaluationDate: '', modules: ['shoulder'] },
    { createdAt: '2025-12-09', evaluationDate: '2025-12-27', modules: ['knee', 'shoulder'] },
    { createdAt: '2026-02-06', evaluationDate: '', modules: ['shoulder', 'spine'] },
    { createdAt: '2026-03-12', evaluationDate: '2026-03-25', modules: ['shoulder'] },
  ];

  const names = [
    '김철수', '이영미', '박준호', '최선영', '정수민',
    '한지훈', '조현우', '윤상미', '강민석', '오진아',
    '박경훈', '신다은', '임효진', '유동현', '문형준', '송은지',
    '서지연', '장민호', '노유진', '백승현', '하은서',
  ];

  const kneeReturnConsiderationsMap = {
    0: '무거운 물건 취급을 제한하고 쪼그려 앉는 작업은 피하는 것이 좋습니다.',
    3: '계단 오르내리기와 반복 굴곡 작업을 줄이고 보호대 착용을 권고합니다.',
    7: '중량물 취급과 장시간 입식 작업을 제한하고 무릎 부담 자세를 피해야 합니다.',
    18: '어깨와 무릎 부담이 모두 큰 반복 운반 작업은 축소 배치가 필요합니다.',
  };

  const shoulderReturnConsiderationsMap = {
    16: '어깨 위 작업과 반복 팔 올림 동작을 제한하고 충분한 휴식시간을 배정합니다.',
    18: '중량물 상하차와 상지 반복 작업을 줄이고 교대 배치를 권고합니다.',
    20: '견봉 위 작업을 줄이고 진동 공구 사용 시간을 최소화하는 것이 좋습니다.',
  };

  const job1Periods = [
    { years: 6, months: 3 },
    { years: 8, months: 6 },
    { years: 11, months: 0 },
    { years: 14, months: 2 },
    { years: 9, months: 8 },
    { years: 17, months: 1 },
    { years: 12, months: 4 },
    { years: 19, months: 0 },
    { years: 7, months: 10 },
    { years: 10, months: 5 },
    { years: 15, months: 7 },
    { years: 13, months: 2 },
    { years: 18, months: 6 },
    { years: 5, months: 11 },
    { years: 16, months: 3 },
    { years: 8, months: 9 },
    { years: 20, months: 0 },
    { years: 6, months: 7 },
    { years: 11, months: 6 },
    { years: 9, months: 1 },
    { years: 14, months: 9 },
  ];

  const job2Periods = [
    { years: 4, months: 6 },
    { years: 5, months: 0 },
    { years: 7, months: 2 },
    { years: 3, months: 8 },
    { years: 6, months: 4 },
    { years: 8, months: 0 },
    { years: 5, months: 7 },
    { years: 9, months: 3 },
    { years: 4, months: 11 },
    { years: 6, months: 0 },
    { years: 7, months: 8 },
    { years: 5, months: 4 },
    { years: 8, months: 6 },
    { years: 3, months: 10 },
    { years: 6, months: 9 },
    { years: 4, months: 2 },
    { years: 7, months: 0 },
    { years: 5, months: 6 },
    { years: 8, months: 1 },
    { years: 4, months: 8 },
    { years: 6, months: 11 },
  ];

  const job1Profiles = [
    { jobName: '건설 현장 배관공', workDaysPerYear: 248 },
    { jobName: '병원 행정 사무원', workDaysPerYear: 238 },
    { jobName: '학교 시설관리원', workDaysPerYear: 245 },
    { jobName: '조선소 용접공', workDaysPerYear: 252 },
    { jobName: '요양병원 간호조무사', workDaysPerYear: 244 },
    { jobName: '의류 봉제 작업자', workDaysPerYear: 246 },
    { jobName: '대형마트 진열 담당', workDaysPerYear: 250 },
    { jobName: '축산물 가공 작업자', workDaysPerYear: 251 },
    { jobName: '공작기계 조작원', workDaysPerYear: 247 },
    { jobName: '토목 현장 측량보조', workDaysPerYear: 243 },
    { jobName: '재가요양보호사', workDaysPerYear: 242 },
    { jobName: '회계 사무원', workDaysPerYear: 236 },
    { jobName: '농산물 선별 작업자', workDaysPerYear: 249 },
    { jobName: '제빵 생산라인 작업자', workDaysPerYear: 246 },
    { jobName: '호텔 객실 정비원', workDaysPerYear: 241 },
    { jobName: '전기 설비 시공기사', workDaysPerYear: 248 },
    { jobName: '자동차 도장 작업자', workDaysPerYear: 245 },
    { jobName: '반도체 장비 오퍼레이터', workDaysPerYear: 242 },
    { jobName: '천장재 시공 기사', workDaysPerYear: 247 },
    { jobName: '어린이집 보육교사', workDaysPerYear: 239 },
    { jobName: '재활병원 물리치료 보조', workDaysPerYear: 243 },
  ];

  const job2Profiles = [
    { jobName: '물류센터 상하차원', workDaysPerYear: 260 },
    { jobName: '고객센터 상담원', workDaysPerYear: 239 },
    { jobName: '통학버스 운전원', workDaysPerYear: 244 },
    { jobName: '설비 유지보수 기사', workDaysPerYear: 248 },
    { jobName: '내시경실 보조인력', workDaysPerYear: 243 },
    { jobName: '검품 포장 작업자', workDaysPerYear: 247 },
    { jobName: '택배 배송 기사', workDaysPerYear: 255 },
    { jobName: '냉동창고 피킹 작업자', workDaysPerYear: 252 },
    { jobName: '품질검사 담당자', workDaysPerYear: 241 },
    { jobName: '현장 안전관리자', workDaysPerYear: 240 },
    { jobName: '병동 이송보조원', workDaysPerYear: 246 },
    { jobName: '구매팀 사무직', workDaysPerYear: 237 },
    { jobName: '스마트팜 재배관리원', workDaysPerYear: 245 },
    { jobName: '카페 매장 관리자', workDaysPerYear: 242 },
    { jobName: '세탁물 정리 담당', workDaysPerYear: 244 },
    { jobName: '건물 시설관리 기사', workDaysPerYear: 246 },
    { jobName: '자동차 정비 보조원', workDaysPerYear: 248 },
    { jobName: '총무팀 운영 담당', workDaysPerYear: 236 },
    { jobName: '가구 조립 설치원', workDaysPerYear: 249 },
    { jobName: '학원 행정실 직원', workDaysPerYear: 238 },
    { jobName: '도수치료실 코디네이터', workDaysPerYear: 240 },
  ];

  const burdenPresets = {
    construction: {
      knee: [
        { weight: 3200, squatting: 95, stairs: true, kneeTwist: true, startStop: true, tightSpace: true, kneeContact: false, jumpDown: true },
        { weight: 2300, squatting: 60, stairs: true, kneeTwist: true, startStop: false, tightSpace: false, kneeContact: true, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 2.0, repetitiveMediumHours: 1.6, repetitiveFastHours: 0.8, heavyLoadCount: 30, heavyLoadSeconds: 15, vibrationHours: 1.0 },
        { overheadHours: 1.4, repetitiveMediumHours: 1.1, repetitiveFastHours: 0.5, heavyLoadCount: 18, heavyLoadSeconds: 12, vibrationHours: 0.6 },
      ],
      spineTasks: [
        { name: '중량 자재 운반', posture: 'G5', weight: 24, frequency: 34, timeValue: 8, correctionFactor: 1.2 },
        { name: '천장 자재 설치', posture: 'G7', weight: 18, frequency: 42, timeValue: 6, correctionFactor: 1.3 },
      ],
    },
    office: {
      knee: [
        { weight: 700, squatting: 10, stairs: false, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 500, squatting: 6, stairs: false, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 0.4, repetitiveMediumHours: 1.1, repetitiveFastHours: 0.2, heavyLoadCount: 3, heavyLoadSeconds: 5, vibrationHours: 0.0 },
        { overheadHours: 0.2, repetitiveMediumHours: 0.7, repetitiveFastHours: 0.1, heavyLoadCount: 2, heavyLoadSeconds: 4, vibrationHours: 0.0 },
      ],
      spineTasks: [
        { name: '문서 상자 이동', posture: 'G3', weight: 8, frequency: 14, timeValue: 5, correctionFactor: 1.0 },
        { name: '사무 비품 정리', posture: 'G4', weight: 6, frequency: 18, timeValue: 4, correctionFactor: 1.0 },
      ],
    },
    caregiving: {
      knee: [
        { weight: 1400, squatting: 36, stairs: true, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 900, squatting: 22, stairs: false, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 0.9, repetitiveMediumHours: 2.3, repetitiveFastHours: 0.4, heavyLoadCount: 10, heavyLoadSeconds: 10, vibrationHours: 0.1 },
        { overheadHours: 0.6, repetitiveMediumHours: 1.8, repetitiveFastHours: 0.3, heavyLoadCount: 8, heavyLoadSeconds: 8, vibrationHours: 0.1 },
      ],
      spineTasks: [
        { name: '환자 체위 변경', posture: 'G6', weight: 16, frequency: 24, timeValue: 6, correctionFactor: 1.2 },
        { name: '침상 이동 보조', posture: 'G7', weight: 14, frequency: 20, timeValue: 7, correctionFactor: 1.3 },
      ],
    },
    manufacturing: {
      knee: [
        { weight: 1900, squatting: 44, stairs: false, kneeTwist: true, startStop: true, tightSpace: false, kneeContact: true, jumpDown: false },
        { weight: 1300, squatting: 28, stairs: false, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 1.2, repetitiveMediumHours: 2.0, repetitiveFastHours: 0.9, heavyLoadCount: 16, heavyLoadSeconds: 11, vibrationHours: 0.8 },
        { overheadHours: 0.8, repetitiveMediumHours: 1.4, repetitiveFastHours: 0.6, heavyLoadCount: 10, heavyLoadSeconds: 9, vibrationHours: 0.5 },
      ],
      spineTasks: [
        { name: '부품 상자 이동', posture: 'G4', weight: 15, frequency: 32, timeValue: 5, correctionFactor: 1.1 },
        { name: '라인 자재 공급', posture: 'G5', weight: 18, frequency: 28, timeValue: 6, correctionFactor: 1.2 },
      ],
    },
    logistics: {
      knee: [
        { weight: 2600, squatting: 60, stairs: true, kneeTwist: true, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 1800, squatting: 34, stairs: true, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 1.4, repetitiveMediumHours: 1.8, repetitiveFastHours: 0.8, heavyLoadCount: 24, heavyLoadSeconds: 12, vibrationHours: 0.5 },
        { overheadHours: 0.9, repetitiveMediumHours: 1.2, repetitiveFastHours: 0.5, heavyLoadCount: 16, heavyLoadSeconds: 10, vibrationHours: 0.3 },
      ],
      spineTasks: [
        { name: '상자 상하차', posture: 'G5', weight: 22, frequency: 38, timeValue: 6, correctionFactor: 1.2 },
        { name: '피킹 카트 적재', posture: 'G6', weight: 16, frequency: 44, timeValue: 5, correctionFactor: 1.1 },
      ],
    },
    maintenance: {
      knee: [
        { weight: 1700, squatting: 30, stairs: true, kneeTwist: true, startStop: false, tightSpace: true, kneeContact: false, jumpDown: false },
        { weight: 1100, squatting: 18, stairs: true, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 1.3, repetitiveMediumHours: 1.5, repetitiveFastHours: 0.6, heavyLoadCount: 12, heavyLoadSeconds: 10, vibrationHours: 1.2 },
        { overheadHours: 0.8, repetitiveMediumHours: 1.0, repetitiveFastHours: 0.3, heavyLoadCount: 8, heavyLoadSeconds: 8, vibrationHours: 0.8 },
      ],
      spineTasks: [
        { name: '설비 부품 교체', posture: 'G6', weight: 17, frequency: 26, timeValue: 7, correctionFactor: 1.3 },
        { name: '공구함 이동', posture: 'G4', weight: 13, frequency: 30, timeValue: 5, correctionFactor: 1.1 },
      ],
    },
    service: {
      knee: [
        { weight: 1000, squatting: 20, stairs: true, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 700, squatting: 12, stairs: false, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 0.9, repetitiveMediumHours: 1.4, repetitiveFastHours: 0.5, heavyLoadCount: 6, heavyLoadSeconds: 7, vibrationHours: 0.1 },
        { overheadHours: 0.5, repetitiveMediumHours: 1.0, repetitiveFastHours: 0.3, heavyLoadCount: 4, heavyLoadSeconds: 6, vibrationHours: 0.0 },
      ],
      spineTasks: [
        { name: '물품 진열', posture: 'G3', weight: 10, frequency: 24, timeValue: 4, correctionFactor: 1.0 },
        { name: '청소 장비 이동', posture: 'G4', weight: 9, frequency: 20, timeValue: 5, correctionFactor: 1.0 },
      ],
    },
    precision: {
      knee: [
        { weight: 900, squatting: 14, stairs: false, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 600, squatting: 8, stairs: false, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 0.7, repetitiveMediumHours: 1.0, repetitiveFastHours: 0.4, heavyLoadCount: 4, heavyLoadSeconds: 6, vibrationHours: 0.2 },
        { overheadHours: 0.4, repetitiveMediumHours: 0.8, repetitiveFastHours: 0.2, heavyLoadCount: 2, heavyLoadSeconds: 5, vibrationHours: 0.1 },
      ],
      spineTasks: [
        { name: '장비 카세트 교체', posture: 'G4', weight: 9, frequency: 18, timeValue: 4, correctionFactor: 1.0 },
        { name: '소모품 박스 이동', posture: 'G3', weight: 7, frequency: 22, timeValue: 4, correctionFactor: 1.0 },
      ],
    },
    driving: {
      knee: [
        { weight: 1200, squatting: 12, stairs: true, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
        { weight: 900, squatting: 8, stairs: false, kneeTwist: false, startStop: true, tightSpace: false, kneeContact: false, jumpDown: false },
      ],
      shoulder: [
        { overheadHours: 0.6, repetitiveMediumHours: 0.9, repetitiveFastHours: 0.2, heavyLoadCount: 6, heavyLoadSeconds: 8, vibrationHours: 1.3 },
        { overheadHours: 0.5, repetitiveMediumHours: 0.7, repetitiveFastHours: 0.1, heavyLoadCount: 5, heavyLoadSeconds: 6, vibrationHours: 1.0 },
      ],
      spineTasks: [
        { name: '적재함 정리', posture: 'G4', weight: 11, frequency: 18, timeValue: 5, correctionFactor: 1.0 },
        { name: '운행 전 차량 점검', posture: 'G3', weight: 8, frequency: 16, timeValue: 4, correctionFactor: 1.0 },
      ],
    },
  };

  const job1BurdenKeys = [
    'construction', 'office', 'maintenance', 'construction', 'caregiving',
    'manufacturing', 'service', 'manufacturing', 'precision', 'construction',
    'caregiving', 'office', 'manufacturing', 'manufacturing', 'service',
    'maintenance', 'manufacturing', 'precision', 'construction', 'caregiving',
    'caregiving',
  ];

  const job2BurdenKeys = [
    'logistics', 'office', 'driving', 'maintenance', 'caregiving',
    'manufacturing', 'logistics', 'logistics', 'precision', 'office',
    'caregiving', 'office', 'manufacturing', 'service', 'service',
    'maintenance', 'maintenance', 'office', 'manufacturing', 'office',
    'caregiving',
  ];

  const formatDecimal = (value) => (Math.round(value * 10) / 10).toFixed(1);

  const buildKneeExtra = (sharedJobId, preset, slot, seed) => {
    const base = preset.knee[slot];
    return {
      sharedJobId,
      weight: String(base.weight + (seed % 3) * 60),
      squatting: String(base.squatting + (seed % 4) * 3),
      evidenceSources: [],
      stairs: base.stairs,
      kneeTwist: base.kneeTwist,
      startStop: base.startStop,
      tightSpace: base.tightSpace,
      kneeContact: base.kneeContact,
      jumpDown: base.jumpDown,
    };
  };

  const buildShoulderExtra = (sharedJobId, preset, slot, seed) => {
    const base = preset.shoulder[slot];
    return {
      sharedJobId,
      overheadHours: formatDecimal(base.overheadHours + (seed % 2) * 0.2),
      repetitiveMediumHours: formatDecimal(base.repetitiveMediumHours + (seed % 3) * 0.2),
      repetitiveFastHours: formatDecimal(base.repetitiveFastHours + (seed % 2) * 0.1),
      heavyLoadCount: String(base.heavyLoadCount + (seed % 4) * 2),
      heavyLoadSeconds: String(base.heavyLoadSeconds + (seed % 3)),
      vibrationHours: formatDecimal(base.vibrationHours + (seed % 2) * 0.1),
      evidenceSources: [],
    };
  };

  const buildSpineTasks = (sharedJobId, preset, idSeed, seed) =>
    preset.spineTasks.map((task, taskIdx) => ({
      id: idSeed + taskIdx,
      sharedJobId,
      name: task.name,
      posture: task.posture,
      weight: task.weight + ((seed + taskIdx) % 3),
      frequency: task.frequency + ((seed + taskIdx) % 4) * 2,
      timeValue: task.timeValue,
      timeUnit: 'sec',
      correctionFactor: Number((task.correctionFactor + (((seed + taskIdx) % 2) * 0.1)).toFixed(1)),
      force: 0,
    }));

  const toDateString = (date) => {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  };

  const shiftMonths = (date, months) => {
    const next = new Date(date);
    next.setMonth(next.getMonth() + months);
    return next;
  };

  const shiftDays = (date, days) => {
    const next = new Date(date);
    next.setDate(next.getDate() + days);
    return next;
  };

  testData.forEach((data, idx) => {
    const patient = createPatient(data.modules, {});
    const isCompleteCase = Boolean(data.evaluationDate);

    patient.createdAt = `${data.createdAt}T09:${String((idx * 4) % 60).padStart(2, '0')}:00.000Z`;
    patient.data.shared.name = names[idx] || `테스트환자${idx + 1}`;
    patient.data.shared.gender = idx % 2 === 0 ? 'male' : 'female';
    patient.data.shared.height = String(160 + (Math.floor(idx / 2) % 15));
    patient.data.shared.weight = String(60 + (Math.floor(idx / 2) % 20));
    patient.data.shared.birthDate = `${1960 + idx}-${String((idx % 12) + 1).padStart(2, '0')}-15`;
    patient.data.shared.injuryDate = data.createdAt;
    patient.data.shared.evaluationDate = data.evaluationDate;
    patient.data.shared.specialNotes = idx % 3 === 0 ? '기타 동반 질환 없음' : '';
    patient.phase = 'evaluation';

    const diagnoses = [];

    if (data.modules.includes('knee')) {
      if (isCompleteCase && idx === 3) {
        diagnoses.push(
          {
            id: crypto.randomUUID(),
            code: 'M17.1',
            name: '양측성 무릎관절증',
            side: 'right',
            confirmedRight: 'confirmed',
            assessmentRight: 'high',
            klgRight: '3',
          },
          {
            id: crypto.randomUUID(),
            code: 'M17.1',
            name: '양측성 무릎관절증',
            side: 'left',
            confirmedLeft: 'confirmed',
            assessmentLeft: 'low',
            klgLeft: '2',
            reasonLeft: ['mild', 'lowBurden'],
            reasonLeftOther: '',
          }
        );
      } else if (isCompleteCase) {
        diagnoses.push(
          {
            id: crypto.randomUUID(),
            code: 'M17.1',
            name: '양측성 무릎관절증',
            side: 'right',
            confirmedRight: 'confirmed',
            assessmentRight: 'high',
            klgRight: idx % 2 === 0 ? '3' : '2',
          },
          {
            id: crypto.randomUUID(),
            code: 'M17.1',
            name: '양측성 무릎관절증',
            side: 'left',
            confirmedLeft: 'confirmed',
            assessmentLeft: idx === 18 ? 'low' : 'high',
            klgLeft: idx % 2 === 0 ? '2' : '3',
            reasonLeft: idx === 18 ? ['lowBurden'] : [],
            reasonLeftOther: '',
          }
        );
      } else {
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M17.1', name: '양측성 무릎관절증', side: 'right' },
          { id: crypto.randomUUID(), code: 'M17.1', name: '양측성 무릎관절증', side: 'left' }
        );
      }
    }

    if (data.modules.includes('spine')) {
      if (isCompleteCase) {
        diagnoses.push({
          id: crypto.randomUUID(),
          code: 'M51.1',
          name: '요추추간판탈출증',
          side: '',
          confirmedRight: 'confirmed',
          assessmentRight: 'high',
        });
      } else {
        diagnoses.push({
          id: crypto.randomUUID(),
          code: 'M51.1',
          name: '요추추간판탈출증',
          side: '',
        });
      }
    }

    if (data.modules.includes('shoulder')) {
      if (isCompleteCase && idx === 18) {
        diagnoses.push(
          {
            id: crypto.randomUUID(),
            code: 'M75.1',
            name: '회전근개 파열',
            side: 'right',
            ellmanRight: 'Full',
            confirmedRight: 'confirmed',
            assessmentRight: 'high',
          },
          {
            id: crypto.randomUUID(),
            code: 'M75.4',
            name: '어깨 충돌증후군',
            side: 'left',
            ellmanLeft: 'Grade 2',
            confirmedLeft: 'confirmed',
            assessmentLeft: 'low',
            reasonLeft: ['lowBurden'],
            reasonLeftOther: '',
          }
        );
      } else if (isCompleteCase) {
        diagnoses.push(
          {
            id: crypto.randomUUID(),
            code: 'M75.1',
            name: '회전근개 파열',
            side: 'right',
            ellmanRight: idx % 4 === 0 ? 'Grade 3' : 'Grade 2',
            confirmedRight: 'confirmed',
            assessmentRight: 'high',
          },
          {
            id: crypto.randomUUID(),
            code: 'M75.4',
            name: '어깨 충돌증후군',
            side: 'left',
            ellmanLeft: idx % 5 === 0 ? 'Grade 1' : 'Grade 2',
            confirmedLeft: 'confirmed',
            assessmentLeft: 'high',
          }
        );
      } else {
        diagnoses.push(
          { id: crypto.randomUUID(), code: 'M75.1', name: '회전근개 파열', side: 'right' },
          { id: crypto.randomUUID(), code: 'M75.4', name: '어깨 충돌증후군', side: 'left' }
        );
      }
    }

    if (diagnoses.length === 0) {
      diagnoses.push({ id: crypto.randomUUID(), code: 'M79.3', name: '근육통', side: '' });
    }
    patient.data.shared.diagnoses = diagnoses;

    const job1Id = crypto.randomUUID();
    const job2Id = crypto.randomUUID();
    const injuryDate = new Date(`${data.createdAt}T09:00:00`);
    const job2Period = job2Periods[idx % job2Periods.length];
    const job1Period = job1Periods[idx % job1Periods.length];
    const job1Profile = job1Profiles[idx % job1Profiles.length];
    const job2Profile = job2Profiles[idx % job2Profiles.length];
    const job1Burden = burdenPresets[job1BurdenKeys[idx % job1BurdenKeys.length]];
    const job2Burden = burdenPresets[job2BurdenKeys[idx % job2BurdenKeys.length]];
    const job2DurationMonths = job2Period.years * 12 + job2Period.months;
    const job1DurationMonths = job1Period.years * 12 + job1Period.months;
    const job2EndDate = injuryDate;
    const job2StartDate = shiftMonths(job2EndDate, -job2DurationMonths);
    const job1EndDate = shiftDays(job2StartDate, -1);
    const job1StartDate = shiftMonths(job1EndDate, -job1DurationMonths);

    patient.data.shared.jobs = [
      {
        id: job1Id,
        jobName: job1Profile.jobName,
        presetId: null,
        startDate: toDateString(job1StartDate),
        endDate: toDateString(job1EndDate),
        workPeriodOverride: '',
        workDaysPerYear: job1Profile.workDaysPerYear,
      },
      {
        id: job2Id,
        jobName: job2Profile.jobName,
        presetId: null,
        startDate: toDateString(job2StartDate),
        endDate: toDateString(job2EndDate),
        workPeriodOverride: '',
        workDaysPerYear: job2Profile.workDaysPerYear,
      },
    ];

    if (data.modules.includes('knee')) {
      patient.data.modules.knee = {
        jobExtras: [
          buildKneeExtra(job1Id, job1Burden, 0, idx),
          buildKneeExtra(job2Id, job2Burden, 1, idx + 1),
        ],
        returnConsiderations: kneeReturnConsiderationsMap[idx] || '',
      };
    }

    if (data.modules.includes('shoulder')) {
      patient.data.modules.shoulder = {
        jobExtras: [
          buildShoulderExtra(job1Id, job1Burden, 0, idx),
          buildShoulderExtra(job2Id, job2Burden, 1, idx + 2),
        ],
        returnConsiderations: shoulderReturnConsiderationsMap[idx] || '',
      };
    }

    if (data.modules.includes('spine')) {
      patient.data.modules.spine = {
        tasks: [
          ...buildSpineTasks(job1Id, job1Burden, idx * 100 + 1, idx),
          ...buildSpineTasks(job2Id, job2Burden, idx * 100 + 21, idx + 1),
        ],
      };
    }

    testPatients.push(patient);
  });

  return testPatients;
}
