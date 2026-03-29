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
export function createTestPatients() {
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
