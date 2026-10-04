import { isPatientComplete } from './patientCompletion';
import { getOwnerGroupKey } from './patientOwnership';
import { formatBirthDate } from './data';
import { toLocalDateString } from './common';
import { calculateAgeStrict } from '@analytics-core';

export const UNASSIGNED_GROUP_KEY = '__unassigned__';

// 환자를 소유자(의사) 그룹으로 집계.
// 그룹 키: assignedDoctorUserId(top-level → meta) 우선, 없으면 meta.createdBy.
// null/undefined는 __unassigned__로 묶음. 각 그룹의 라벨(doctorName 샘플)을 함께 산출.
// 반환: [{ key, label, count }] (정렬 없음)
function groupPatientsByOwner(patients) {
  const list = Array.isArray(patients) ? patients : [];
  const groups = new Map();

  for (const p of list) {
    const raw = getOwnerGroupKey(p);
    const key = raw == null ? UNASSIGNED_GROUP_KEY : raw;
    const entry = groups.get(key) || { key, count: 0, doctorNameSample: null };
    entry.count += 1;
    if (!entry.doctorNameSample) {
      const dn = p?.data?.shared?.doctorName;
      if (dn) entry.doctorNameSample = String(dn);
    }
    groups.set(key, entry);
  }

  const formatLabel = (entry) => {
    if (entry.key === UNASSIGNED_GROUP_KEY) return '미배정/알 수 없음';
    if (entry.doctorNameSample) return entry.doctorNameSample;
    const id = String(entry.key);
    return id.length > 8 ? `${id.slice(0, 8)}…` : id;
  };

  return [...groups.values()].map(e => ({ key: e.key, label: formatLabel(e), count: e.count }));
}

// 의사별 환자 수 집계 (Top 5 + 미배정 별도)
// roster(서버 명부 — Dashboard가 이미 받는 `{ doctors:[{ userId, name, count }] }`)가 있으면
// 그 이름을 최우선으로 쓴다. 환자 데이터의 shared.doctorName은 자유 텍스트라 그룹 환자 전원이
// 비어 있으면 UUID 앞 8자로 폴백되던 문제를 막는다. 명부에 없거나 이름이 비면 기존 폴백 유지.
export function getDoctorPatientCounts(patients, { topN = 5, roster } = {}) {
  const rosterNames = new Map();
  for (const d of Array.isArray(roster?.doctors) ? roster.doctors : []) {
    const name = d?.name && String(d.name).trim() ? String(d.name).trim() : null;
    if (d?.userId && name) rosterNames.set(String(d.userId), name);
  }
  const all = groupPatientsByOwner(patients).map((e) => (
    e.key !== UNASSIGNED_GROUP_KEY && rosterNames.has(String(e.key))
      ? { ...e, label: rosterNames.get(String(e.key)) }
      : e
  ));

  const unassigned = all.find(e => e.key === UNASSIGNED_GROUP_KEY) || null;
  const assigned = all.filter(e => e.key !== UNASSIGNED_GROUP_KEY)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);

  return { top: assigned, unassigned };
}

// 등록 환자를 가진 모든 의사 옵션 (관리자 통계 드롭다운용).
// count 내림차순 정렬, 미배정 그룹은 항상 마지막에 배치.
// 반환: [{ key, label, count }]
export function getDoctorOptions(patients) {
  const all = groupPatientsByOwner(patients);

  const assigned = all.filter(e => e.key !== UNASSIGNED_GROUP_KEY)
    .sort((a, b) => b.count - a.count);
  const unassigned = all.find(e => e.key === UNASSIGNED_GROUP_KEY);

  return unassigned ? [...assigned, unassigned] : assigned;
}

// 서버 명부(fetchDoctorCounts 결과)로부터 대시보드 드롭다운 옵션 생성.
// - 본인(currentUserId)은 옵션에서 제외하되, 그 count는 myCount로 따로 반환
//   ("내 환자 통계 (N명)" 라벨용).
// - count 내림차순 정렬, 미배정(unassignedCount>0)은 마지막.
// - 이름이 없으면(계정 삭제 등) id 축약 라벨로 폴백 (groupPatientsByOwner와 동일 규칙).
// 반환: { options: [{ key, label, count }], myCount }
export function getDoctorOptionsFromRoster(roster, { currentUserId } = {}) {
  const doctors = Array.isArray(roster?.doctors) ? roster.doctors : [];
  const unassignedCount = Number(roster?.unassignedCount) || 0;

  let myCount = 0;
  const options = [];
  for (const d of doctors) {
    const count = Number(d?.count) || 0;
    if (currentUserId && d?.userId === currentUserId) {
      myCount = count; // 제외 전에 캡처
      continue;        // 본인 제외 (Issue 1)
    }
    const name = d?.name && String(d.name).trim() ? String(d.name) : null;
    const id = String(d?.userId ?? '');
    const label = name || (id.length > 8 ? `${id.slice(0, 8)}…` : id);
    options.push({ key: d.userId, label, count });
  }
  options.sort((a, b) => b.count - a.count);

  if (unassignedCount > 0) {
    options.push({ key: UNASSIGNED_GROUP_KEY, label: '미배정/알 수 없음', count: unassignedCount });
  }

  return { options, myCount };
}


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
    const [_y, m, day] = monday.split('-');
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

// 최근 활동 정렬용 timestamp (epoch ms).
// sync.lastSyncedAt은 동기화 시각이지 사용자 활동 시각이 아니므로 의도적으로 제외한다.
// updatedAt → _savedAt → createdAt 순으로 본다. invalid는 0.
function getRecentActivityTimestamp(patient) {
  const candidates = [patient?.updatedAt, patient?._savedAt, patient?.createdAt];
  for (const c of candidates) {
    if (typeof c !== 'string' || !c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return 0;
}

// shared.gender의 다양한 표기(M/F, 남/여, male/female 등)를 정규화.
export function normalizeGender(raw) {
  if (typeof raw !== 'string') return 'unknown';
  const s = raw.trim().toLowerCase();
  if (!s) return 'unknown';
  if (s === 'm' || s === 'male' || s === '남' || s === '남자' || s === '남성') return 'male';
  if (s === 'f' || s === 'female' || s === '여' || s === '여자' || s === '여성') return 'female';
  return 'unknown';
}

// 대시보드 집계에서 비현실적인 나이로 보고 제외하는 상한. core의 calculateAgeStrict에는 상한이 없다
// (통계 변수는 값을 임의로 잘라내지 않는다) — 기존 대시보드 정책(0~120)을 이 집계 계층에서만 유지한다.
export const MAX_PLAUSIBLE_AGE = 120;

// 기준일(refDate) 시점의 만 나이. 통계 카탈로그의 patient.identity.ageAtInjury와 같은 core 함수
// (calculateAgeStrict — 타임존 비의존 strict ISO 계산)를 쓴다. 이전 computeAge는 `new Date(문자열)`을
// 쓰고 기준일이 없거나 잘못되면 오늘로 대체했는데, 달력에 없는 날짜(2025-02-31)를 다른 날짜로 보정하고
// 시간대에 따라 같은 입력이 24세/25세로 달라졌으며 오늘 대체는 나이가 시간이 지날수록 커지는 오류가 된다.
// 따라서 기준일이 비었거나 잘못되면 오늘로 대체하지 않고 null(집계 제외)을 반환한다.
// 생년월일의 YYYYMMDD 구형식은 대시보드가 지금까지 받아 주었으므로 YYYY-MM-DD로 정규화한 뒤 strict로 계산한다
// (통계 추출기는 strict ISO만 받는다는 차이 — 의도적 호환 유지). 음수·MAX_PLAUSIBLE_AGE 초과는 null.
export function computeAgeAt(birthDate, refDate) {
  if (typeof birthDate !== 'string' || !birthDate) return null;
  if (typeof refDate !== 'string' || !refDate) return null;
  const normalized = formatBirthDate(birthDate);
  if (normalized === '-') return null;
  const age = calculateAgeStrict(normalized, refDate);
  if (age == null || age < 0 || age > MAX_PLAUSIBLE_AGE) return null;
  return age;
}

// 30대 이하(<40) / 40대 / 50대 / 60대 / 70대 이상
function ageGroupKey(age) {
  if (age == null) return null;
  if (age < 40) return '30대↓';
  if (age < 50) return '40대';
  if (age < 60) return '50대';
  if (age < 70) return '60대';
  return '70대↑';
}

function emptyAgeGroupBuckets() {
  return { '30대↓': 0, '40대': 0, '50대': 0, '60대': 0, '70대↑': 0 };
}

function topN(map, n) {
  return Array.from(map.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, n)
    .map(([key, v]) => ({ key, ...v }));
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
    .sort((a, b) => getRecentActivityTimestamp(b) - getRecentActivityTimestamp(a))
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
      registrationDate: toLocalDateString(registrationTimestamp),
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

  // ─── 성별/연령/직종/상병 by-gender 집계 ────────────────────────────────
  const genderBreakdown = { male: 0, female: 0, unknown: 0 };
  const ageSums = { all: 0, male: 0, female: 0 };
  const ageCounts = { all: 0, male: 0, female: 0 };
  const ageGroupDistribution = {
    all: emptyAgeGroupBuckets(),
    male: emptyAgeGroupBuckets(),
    female: emptyAgeGroupBuckets(),
  };
  const jobMaps = { all: new Map(), male: new Map(), female: new Map() };
  const diagMaps = { all: new Map(), male: new Map(), female: new Map() };

  allPatients.forEach(p => {
    const shared = p?.data?.shared || {};
    const g = normalizeGender(shared.gender);
    genderBreakdown[g] += 1;

    // 재해일자 기준(인적사항 "만 나이"·통계 변수와 동일). 재해일자가 없거나 잘못되면 집계에서 제외한다.
    const age = computeAgeAt(shared.birthDate, shared.injuryDate);
    if (age != null) {
      ageSums.all += age; ageCounts.all += 1;
      const gk = ageGroupKey(age);
      if (gk) ageGroupDistribution.all[gk] += 1;
      if (g !== 'unknown') {
        ageSums[g] += age; ageCounts[g] += 1;
        if (gk) ageGroupDistribution[g][gk] += 1;
      }
    }

    const jobName = shared.jobs?.[0]?.jobName;
    if (jobName) {
      const bumpJob = (map) => {
        const cur = map.get(jobName) || { count: 0 };
        cur.count += 1;
        map.set(jobName, cur);
      };
      bumpJob(jobMaps.all);
      if (g !== 'unknown') bumpJob(jobMaps[g]);
    }

    const diagnoses = (shared.diagnoses || []).filter(d => d?.code);
    const seen = new Set();
    diagnoses.forEach(d => {
      const code = d.code;
      if (seen.has(code)) return;
      seen.add(code);
      const bumpDiag = (map) => {
        const cur = map.get(code) || { count: 0, name: d.name || '' };
        cur.count += 1;
        if (!cur.name && d.name) cur.name = d.name;
        map.set(code, cur);
      };
      bumpDiag(diagMaps.all);
      if (g !== 'unknown') bumpDiag(diagMaps[g]);
    });
  });

  const avgAgeByGender = {
    all: ageCounts.all > 0 ? Math.round((ageSums.all / ageCounts.all) * 10) / 10 : null,
    male: ageCounts.male > 0 ? Math.round((ageSums.male / ageCounts.male) * 10) / 10 : null,
    female: ageCounts.female > 0 ? Math.round((ageSums.female / ageCounts.female) * 10) / 10 : null,
  };
  const topJobsByGender = {
    all: topN(jobMaps.all, 5),
    male: topN(jobMaps.male, 5),
    female: topN(jobMaps.female, 5),
  };
  const topDiagnosesByGender = {
    all: topN(diagMaps.all, 5),
    male: topN(diagMaps.male, 5),
    female: topN(diagMaps.female, 5),
  };

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
    genderBreakdown,
    avgAgeByGender,
    ageGroupDistribution,
    topJobsByGender,
    topDiagnosesByGender,
  };
};
