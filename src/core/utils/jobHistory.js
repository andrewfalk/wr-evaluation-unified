// 직업력([직업력]) 출력 공통 함수. 종합소견 미리보기·EMR(txtJobCusCont/txtSyth1Cont)·엑셀·통합 텍스트
// 리포트가 같은 포맷을 쓰도록 한 곳에서 만든다.
//
// "신체부담평가 미포함" 직력(shared.jobs[].excludeFromAnalysis)은 신체부담 평가에서만 빠지고 직업력
// 출력에는 남는다 — 포함 직력(원래 순서)을 먼저, 미포함 직력을 가장 끝에 "신체부담평가에는 미포함"
// 표기와 함께 둔다. 포함 직력은 직력1..k가 되어 모듈 블록의 직력 번호(포함 직력만 가진 calc 순번)와
// 같다. 미포함 직력이 없으면 출력은 종전과 완전히 같다.

import { getEffectiveWorkPeriodText } from './workPeriod';
import { hasExcludedJobs, isJobExcludedFromAnalysis, orderJobsForHistory } from '@analytics-core/jobScope';

export const EXCLUDED_JOB_LABEL = '신체부담평가에는 미포함';
export const NO_EVALUABLE_JOBS_NOTE = '※ 모든 직력이 신체부담평가에서 제외되어 평가 대상 없음';

/**
 * @param {Array} jobs shared.jobs
 * @returns {{ lines: string[], text: string, numberingByJobId: (Object<string, number>|null) }}
 *   numberingByJobId: 미포함 직력이 하나라도 있을 때만 jobId → 직업력 번호 맵, 없으면 null(각 모듈 블록은
 *   기존 번호 규칙을 그대로 쓴다). 직력 번호를 자기 필터로 다시 매기는 블록(어깨 보고서)만 조회한다.
 */
export function buildJobHistoryLines(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const ordered = orderJobsForHistory(list);
  const withExclusion = hasExcludedJobs(list);
  const numbering = {};

  const lines = ordered.map((job, index) => {
    const number = index + 1;
    if (withExclusion && job && job.id) numbering[job.id] = number;
    let line = `- 직력${number}: ${job.jobName || '-'} | ${getEffectiveWorkPeriodText(job)}`;
    if (isJobExcludedFromAnalysis(job)) line += ` | ${EXCLUDED_JOB_LABEL}`;
    return line;
  });

  return {
    lines,
    text: lines.map((line) => `${line}\n`).join(''),
    numberingByJobId: withExclusion ? numbering : null,
  };
}

/** 모듈 블록의 직력 번호: 번호 맵이 있고 해당 직력이 들어 있으면 그 번호, 아니면 기존 규칙(fallback). */
export function resolveJobNumber(jobNumbering, jobId, fallback) {
  if (jobNumbering && jobId && jobNumbering[jobId]) return jobNumbering[jobId];
  return fallback;
}
