import { isPatientComplete } from './patientCompletion';

function buildMonthBuckets() {
  const now = new Date();
  // 지난 24개월 범위 생성 (데이터가 미래일 수도 있으니)
  const months = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: `${d.getMonth() + 1}월`,
      count: 0,
    });
  }

  // 마지막 12개월만 반환 (최근 12개월)
  return months.slice(-12);
}

function bucketDate(dateStr, months) {
  if (!dateStr) return;
  let key;
  if (dateStr.includes('-') && !dateStr.includes('T')) {
    // YYYY-MM-DD 형식
    key = dateStr.substring(0, 7);
  } else {
    // ISO 형식 (2026-03-28T12:34:56.000Z)
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return;
    key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  const found = months.find(m => m.key === key);
  if (found) found.count++;
}

export const computeDashboardStats = (currentPatients) => {
  const allPatients = (currentPatients || []).map(p => ({ ...p, _savedAt: null }));


  // 완료/진행중 + 모듈 사용량
  let completedCount = 0;
  let inProgressCount = 0;
  const moduleUsage = {};

  allPatients.forEach(p => {
    const mods = p.data?.activeModules || [];
    mods.forEach(mId => { moduleUsage[mId] = (moduleUsage[mId] || 0) + 1; });

    if (isPatientComplete(p)) completedCount++;
    else inProgressCount++;
  });

  // 월별 등록 현황 (createdAt 기준, 폴백: _savedAt)
  const monthlyRegistrations = buildMonthBuckets();
  allPatients.forEach(p => {
    const dateStr = p.createdAt || p._savedAt;
    bucketDate(dateStr, monthlyRegistrations);
  });

  // 월별 평가 현황 (evaluationDate 기준, 완료된 것만)
  const monthlyEvaluations = buildMonthBuckets();
  allPatients.forEach(p => {
    const dateStr = p.data?.shared?.evaluationDate;
    bucketDate(dateStr, monthlyEvaluations);
  });

  // 최근 활동 5건 (최종 수정일 기준)
  const sorted = [...allPatients]
    .sort((a, b) => {
      const da = a.updatedAt || a.createdAt || '';
      const db = b.updatedAt || b.createdAt || '';
      return db.localeCompare(da);
    })
    .slice(0, 5);

  const recentActivity = sorted.map(p => ({
    id: p.id,
    name: p.data?.shared?.name || '이름 없음',
    registrationDate: p.createdAt?.split('T')[0] || '',
    completionDate: p.data?.shared?.evaluationDate || '',
    moduleIds: p.data?.activeModules || [],
    status: isPatientComplete(p) ? '완료' : '진행중',
  }));

  return {
    totalPatients: allPatients.length,
    completedCount,
    inProgressCount,
    moduleUsage,
    monthlyRegistrations,
    monthlyEvaluations,
    recentActivity,
  };
};
