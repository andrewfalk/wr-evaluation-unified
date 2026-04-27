import { isPatientComplete } from './patientCompletion';

// 로컬 시간대 기준으로 Date 객체 반환. ISO와 YYYY-MM-DD 형식 모두 처리
function parseDateLocal(dateStr) {
  if (!dateStr) return null;
  if (dateStr.includes('-') && !dateStr.includes('T')) {
    // YYYY-MM-DD 형식 → 로컬 시간대로 파싱
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  // ISO 또는 기타 형식 → 파싱 후 로컬 getter 사용
  return new Date(dateStr);
}

// 주어진 날짜의 주(week) 월요일 YYYY-MM-DD 반환
function getWeekMonday(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // 월요일로 조정
  const monday = new Date(d.setDate(diff));
  const y = monday.getFullYear();
  const m = String(monday.getMonth() + 1).padStart(2, '0');
  const day_str = String(monday.getDate()).padStart(2, '0');
  return `${y}-${m}-${day_str}`;
}

function buildMonthBuckets() {
  const now = new Date();
  // 지난 6개월 범위 생성
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${d.getMonth() + 1}월`,
      count: 0,
    });
  }

  return months;
}

function buildWeekBuckets() {
  const now = new Date();
  const weeks = [];
  // 현재 주 포함 8개 주 (i = 7..0)
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i * 7);
    const monday = getWeekMonday(d);
    const [y, m, day] = monday.split('-');
    weeks.push({
      key: monday,
      label: `${m}/${day}`,
      count: 0,
    });
  }
  return weeks;
}

function buildDayBuckets() {
  const now = new Date();
  const days = [];
  // 오늘 포함 7일 (i = 6..0)
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const key = `${y}-${m}-${day}`;
    days.push({
      key,
      label: `${d.getDate()}일`,
      count: 0,
    });
  }
  return days;
}

function bucketDate(dateStr, months) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const found = months.find(m => m.key === key);
  if (found) found.count++;
}

function bucketWeek(dateStr, weeks) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const monday = getWeekMonday(d);
  const found = weeks.find(w => w.key === monday);
  if (found) found.count++;
}

function bucketDay(dateStr, days) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const found = days.find(day => day.key === key);
  if (found) found.count++;
}

function calcProcessingDays(createdAt, evaluationDate) {
  if (!createdAt || !evaluationDate) return null;
  const start = new Date(createdAt);
  const end = new Date(evaluationDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return null;
  const diff = Math.round((end - start) / (1000 * 60 * 60 * 24));
  return diff >= 0 ? diff : null;
}

function getRegistrationTimestamp(patient) {
  return patient?.createdAt || patient?._savedAt || '';
}

// 상병을 high > low > 미평가 우선순위로 분류 (스택 차트용 상호배타적 카운트)
function getDiagnosisBreakdown(patient) {
  const diagnoses = (patient.data?.shared?.diagnoses || []).filter(d => d.code || d.name);
  const highCount = diagnoses.filter(
    d => d.assessmentRight === 'high' || d.assessmentLeft === 'high'
  ).length;
  const lowCount = diagnoses.filter(
    d => d.assessmentRight !== 'high' && d.assessmentLeft !== 'high' &&
         (d.assessmentRight === 'low' || d.assessmentLeft === 'low')
  ).length;
  const unassessedCount = diagnoses.length - highCount - lowCount;
  return { highCount, lowCount, unassessedCount };
}

// 기존 버킷 배열을 평가 스택 형식({ highCount, lowCount, unassessedCount, patientCount })으로 변환
function toEvalBuckets(baseBuckets) {
  return baseBuckets.map(({ key, label }) => ({
    key, label, highCount: 0, lowCount: 0, unassessedCount: 0, patientCount: 0,
  }));
}

function bucketEvalDate(dateStr, buckets, breakdown) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const found = buckets.find(b => b.key === key);
  if (found) {
    found.highCount += breakdown.highCount;
    found.lowCount += breakdown.lowCount;
    found.unassessedCount += breakdown.unassessedCount;
    found.patientCount += 1;
  }
}

function bucketEvalWeek(dateStr, buckets, breakdown) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const monday = getWeekMonday(d);
  const found = buckets.find(b => b.key === monday);
  if (found) {
    found.highCount += breakdown.highCount;
    found.lowCount += breakdown.lowCount;
    found.unassessedCount += breakdown.unassessedCount;
    found.patientCount += 1;
  }
}

function bucketEvalDay(dateStr, buckets, breakdown) {
  if (!dateStr) return;
  const d = parseDateLocal(dateStr);
  if (!d || isNaN(d.getTime())) return;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const found = buckets.find(b => b.key === key);
  if (found) {
    found.highCount += breakdown.highCount;
    found.lowCount += breakdown.lowCount;
    found.unassessedCount += breakdown.unassessedCount;
    found.patientCount += 1;
  }
}

export const computeDashboardStats = (currentPatients) => {
  const allPatients = currentPatients || [];


  // 완료/진행중 + 모듈 사용량 + 처리일수 + 전체 상병 집계
  let completedCount = 0;
  let inProgressCount = 0;
  const moduleUsage = {};
  const moduleHighLow = {};
  const processingDaysList = [];
  let totalHighCount = 0;
  let totalLowCount = 0;
  let totalUnassessedCount = 0;

  // 직종별 집계
  const jobStats = {};

  allPatients.forEach(p => {
    const mods = p.data?.activeModules || [];
    const bd = getDiagnosisBreakdown(p);
    const jobs = p.data?.shared?.jobs || [];
    const primaryJob = jobs[0]?.jobName || '';

    // 직종 집계
    if (primaryJob) {
      if (!jobStats[primaryJob]) {
        jobStats[primaryJob] = { count: 0, high: 0, low: 0, unassessed: 0 };
      }
      jobStats[primaryJob].count += 1;
      jobStats[primaryJob].high += bd.highCount;
      jobStats[primaryJob].low += bd.lowCount;
      jobStats[primaryJob].unassessed += bd.unassessedCount;
    }

    // 모듈별 집계
    mods.forEach(mId => {
      moduleUsage[mId] = (moduleUsage[mId] || 0) + 1;
      if (!moduleHighLow[mId]) moduleHighLow[mId] = { high: 0, low: 0, unassessed: 0 };
      moduleHighLow[mId].high += bd.highCount;
      moduleHighLow[mId].low += bd.lowCount;
      moduleHighLow[mId].unassessed += bd.unassessedCount;
    });
    totalHighCount += bd.highCount;
    totalLowCount += bd.lowCount;
    totalUnassessedCount += bd.unassessedCount;

    if (isPatientComplete(p)) completedCount++;
    else inProgressCount++;
  });

  // 상위 3개 직종 추출
  const topJobs = Object.entries(jobStats)
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 3)
    .map(([name, stats]) => ({ name, ...stats }));

  // 월별 등록 현황 (createdAt 기준, 폴백: _savedAt)
  const monthlyRegistrations = buildMonthBuckets();
  allPatients.forEach(p => {
    const dateStr = p.createdAt || p._savedAt;
    bucketDate(dateStr, monthlyRegistrations);
  });

  // 월별 평가 현황 (evaluationDate 기준, 스택 형식)
  const monthlyEvaluations = toEvalBuckets(buildMonthBuckets());
  allPatients.forEach(p => {
    const dateStr = p.data?.shared?.evaluationDate;
    if (dateStr) bucketEvalDate(dateStr, monthlyEvaluations, getDiagnosisBreakdown(p));
  });

  // 최근 활동 5건 (최종 수정일 기준)
  const sorted = [...allPatients]
    .sort((a, b) => {
      const da = a.updatedAt || getRegistrationTimestamp(a);
      const db = b.updatedAt || getRegistrationTimestamp(b);
      return db.localeCompare(da);
    })
    .slice(0, 5);

  const recentActivity = sorted.map(p => {
    const complete = isPatientComplete(p);
    const registrationTimestamp = getRegistrationTimestamp(p);
    const days = complete
      ? calcProcessingDays(registrationTimestamp, p.data?.shared?.evaluationDate)
      : null;

    // 상병 통계 (빈 상병 제외: code || name 조건)
    const diagnoses = (p.data?.shared?.diagnoses || []).filter(d => d.code || d.name);
    const totalDiagnoses = diagnoses.length;
    const highCount = diagnoses.filter(
      d => d.assessmentRight === 'high' || d.assessmentLeft === 'high'
    ).length;
    const lowCount = diagnoses.filter(
      d => d.assessmentRight === 'low' || d.assessmentLeft === 'low'
    ).length;

    return {
      id: p.id,
      patientNo: p.data?.shared?.patientNo || '',
      name: p.data?.shared?.name || '이름 없음',
      jobName: p.data?.shared?.jobs?.[0]?.jobName || '',
      registrationDate: registrationTimestamp?.split('T')[0] || '',
      completionDate: p.data?.shared?.evaluationDate || '',
      moduleIds: p.data?.activeModules || [],
      status: complete ? '완료' : '진행중',
      processingDays: days,
      totalDiagnoses,
      highCount,
      lowCount,
    };
  });

  // 평균 처리일수 (완료 환자 대상)
  allPatients.forEach(p => {
    if (!isPatientComplete(p)) return;

    const days = calcProcessingDays(getRegistrationTimestamp(p), p.data?.shared?.evaluationDate);
    if (days !== null) processingDaysList.push(days);
  });
  const avgProcessingDays = processingDaysList.length > 0
    ? Math.round(processingDaysList.reduce((a, b) => a + b, 0) / processingDaysList.length * 10) / 10
    : null;

  // 주별 등록 현황
  const weeklyRegistrations = buildWeekBuckets();
  allPatients.forEach(p => {
    const dateStr = p.createdAt || p._savedAt;
    bucketWeek(dateStr, weeklyRegistrations);
  });

  // 주별 평가 현황 (스택 형식)
  const weeklyEvaluations = toEvalBuckets(buildWeekBuckets());
  allPatients.forEach(p => {
    const dateStr = p.data?.shared?.evaluationDate;
    if (dateStr) bucketEvalWeek(dateStr, weeklyEvaluations, getDiagnosisBreakdown(p));
  });

  // 일별 등록 현황
  const dailyRegistrations = buildDayBuckets();
  allPatients.forEach(p => {
    const dateStr = p.createdAt || p._savedAt;
    bucketDay(dateStr, dailyRegistrations);
  });

  // 일별 평가 현황 (스택 형식)
  const dailyEvaluations = toEvalBuckets(buildDayBuckets());
  allPatients.forEach(p => {
    const dateStr = p.data?.shared?.evaluationDate;
    if (dateStr) bucketEvalDay(dateStr, dailyEvaluations, getDiagnosisBreakdown(p));
  });

  return {
    totalPatients: allPatients.length,
    completedCount,
    inProgressCount,
    moduleUsage,
    moduleHighLow,
    topJobs,
    totalHighCount,
    totalLowCount,
    totalUnassessedCount,
    monthlyRegistrations,
    monthlyEvaluations,
    weeklyRegistrations,
    weeklyEvaluations,
    dailyRegistrations,
    dailyEvaluations,
    recentActivity,
    avgProcessingDays,
  };
};
