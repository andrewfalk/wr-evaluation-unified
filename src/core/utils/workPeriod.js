// 근무기간 공통 유틸리티 (무릎/척추 공용)

export function calculateWorkPeriod(s, e) {
  if (!s || !e) return 0;
  return Math.max(0, (new Date(e) - new Date(s)) / (1000 * 60 * 60 * 24 * 365.25));
}

export function formatWorkPeriod(s, e) {
  if (!s || !e) return '-';
  const m = Math.round(calculateWorkPeriod(s, e) * 12);
  return `${Math.floor(m / 12)}년 ${m % 12}개월`;
}

export function parseWorkPeriodOverride(str) {
  if (!str) return 0;
  const yMatch = str.match(/(\d+)\s*년/);
  const mMatch = str.match(/(\d+)\s*개월/);
  return (yMatch ? parseInt(yMatch[1]) : 0) + (mMatch ? parseInt(mMatch[1]) : 0) / 12;
}

export function getEffectiveWorkPeriod(job) {
  if (job.workPeriodOverride) return parseWorkPeriodOverride(job.workPeriodOverride);
  return calculateWorkPeriod(job.startDate, job.endDate);
}

export function getEffectiveWorkPeriodText(job) {
  if (job.workPeriodOverride) return job.workPeriodOverride;
  return formatWorkPeriod(job.startDate, job.endDate);
}
