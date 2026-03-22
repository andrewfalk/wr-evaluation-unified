import { calculateAge, calculateBMI } from '../../../core/utils/common';
import { calculateWorkPeriod, formatWorkPeriod, parseWorkPeriodOverride, getEffectiveWorkPeriod, getEffectiveWorkPeriodText } from '../../../core/utils/workPeriod';
import { getDiagnosisModuleHint } from '../../../core/utils/diagnosisMapping';

// re-export for any external consumers
export { calculateWorkPeriod, formatWorkPeriod, parseWorkPeriodOverride, getEffectiveWorkPeriod, getEffectiveWorkPeriodText };

// 신체부담정도 계산
export function calculatePhysicalBurden(w, t) {
  const W = parseFloat(w) || 0;
  const T = parseFloat(t) || 0;

  if ((W >= 3000 && T >= 180) || (W >= 3000 && T >= 120) || (W >= 2000 && T >= 180)) {
    return { level: '고도', minScore: 6.0, maxScore: 9.0 };
  }
  if ((W >= 3000 && T >= 60) || (W >= 2000 && T >= 120) || (W < 2000 && T >= 120)) {
    return { level: '중등도상', minScore: 3.0, maxScore: 6.0 };
  }
  if ((W >= 3000 && T < 60) || (W >= 2000 && T < 120) || (W < 2000 && T >= 60)) {
    return { level: '중등도하', minScore: 2.0, maxScore: 4.0 };
  }
  return { level: '경도', minScore: 1.0, maxScore: 2.0 };
}

// 업무관련성 계산
export function calculateWorkRelatedness(jobs, age) {
  if (!jobs?.length || age <= 30) return { min: 0, max: 0 };
  let sumMin = 0, sumMax = 0;
  jobs.forEach(j => {
    const b = calculatePhysicalBurden(j.weight, j.squatting);
    const p = getEffectiveWorkPeriod(j);
    sumMin += (b.minScore - 1) * p;
    sumMax += (b.maxScore - 1) * p;
  });
  const af = age - 30;
  return {
    min: Math.max(0, (sumMin / (af + sumMin)) * 100).toFixed(1),
    max: Math.max(0, (sumMax / (af + sumMax)) * 100).toFixed(1)
  };
}

export function evaluateCumulativeBurden(min, max) {
  return ((parseFloat(min) + parseFloat(max)) / 2) >= 50 ? '충분함' : '불충분함';
}

// 텍스트 헬퍼
export const getSideText = (side) =>
  side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';

export const getStatusText = (status) =>
  status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';

export const getKlgText = (klg) =>
  klg === 'N/A' ? '해당없음' : klg ? `${klg}등급` : '-';

export const getReasonText = (reasons, other) => {
  if (typeof reasons === 'string') reasons = reasons ? [reasons] : [];
  if (!reasons || reasons.length === 0) return '-';
  const reasonMap = {
    unrelated: '신체부담과 관련없는 상병',
    mild: '상병 미확인/연령대비 경미',
    delayed: '업무중단 후 상당기간 경과',
    lowBurden: '누적 신체부담 낮음',
    other: `기타 (${other || ''})`
  };
  return reasons.map(r => reasonMap[r] || r).join('\n');
};

// shared.jobs + knee.jobExtras를 합성하여 계산용 job 배열 생성
function mergeJobsWithExtras(sharedJobs, kneeExtras) {
  return (sharedJobs || []).map(sj => {
    const extra = (kneeExtras || []).find(e => e.sharedJobId === sj.id) || {};
    return {
      ...sj,
      weight: extra.weight || '',
      squatting: extra.squatting || '',
      evidenceSources: extra.evidenceSources || [],
      stairs: extra.stairs || false,
      kneeTwist: extra.kneeTwist || false,
      startStop: extra.startStop || false,
      tightSpace: extra.tightSpace || false,
      kneeContact: extra.kneeContact || false,
      jumpDown: extra.jumpDown || false,
    };
  });
}

// 종합소견 완료 여부 판정 (무릎 상병만 체크)
export function isKneeAssessmentComplete(patientData) {
  const diagnoses = patientData.shared?.diagnoses || [];
  if (!diagnoses.length) return false;
  // 무릎 상병만 필터링하여 체크
  const kneeDiags = diagnoses.filter(dx => {
    const hint = getDiagnosisModuleHint(dx);
    return !hint || hint.moduleId === 'knee';
  });
  if (!kneeDiags.length) return true; // 무릎 상병이 없으면 무릎 기준 완료
  return kneeDiags.every(dx => {
    if (!dx.side) return false;
    const needRight = dx.side === 'right' || dx.side === 'both';
    const needLeft = dx.side === 'left' || dx.side === 'both';
    if (needRight) {
      if (!dx.confirmedRight || !dx.assessmentRight) return false;
      if (dx.assessmentRight === 'low' && (!dx.reasonRight?.length)) return false;
    }
    if (needLeft) {
      if (!dx.confirmedLeft || !dx.assessmentLeft) return false;
      if (dx.assessmentLeft === 'low' && (!dx.reasonLeft?.length)) return false;
    }
    return true;
  });
}

// 환자 데이터로부터 전체 계산 결과 산출
export function computeKneeCalc(patientData) {
  const shared = patientData.shared || {};
  const mod = patientData.module || {};
  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  // 신형식: shared.jobs + mod.jobExtras 합성
  // 구형식 호환: mod.jobs가 있으면 그대로 사용
  const jobs = mod.jobs
    ? mod.jobs
    : mergeJobsWithExtras(shared.jobs, mod.jobExtras);

  const relatedness = calculateWorkRelatedness(jobs, age);
  const cumulativeBurden = evaluateCumulativeBurden(relatedness.min, relatedness.max);
  const jobBurdens = jobs.map(j => ({
    ...j,
    burden: calculatePhysicalBurden(j.weight, j.squatting),
    period: getEffectiveWorkPeriodText(j)
  }));
  return { age, bmi, relatedness, cumulativeBurden, jobBurdens };
}
