// PR0-B1: 계산 함수 7개는 packages/analytics-core/modules/knee로 이동했다(클라이언트·서버
// 공유). 이 파일은 옛 import 경로를 유지하기 위한 shim이다 — registerModule() 호출부와
// JobTab.jsx 등 기존 소비자는 무변경.
export {
  calculatePhysicalBurden,
  calculateWorkRelatedness,
  evaluateCumulativeBurden,
  mergeJobsWithExtras,
  resolveKneeCalculationJobs,
  computeKneeCalc,
  isKneeAssessmentComplete,
} from '@analytics-core/modules/knee/index';

// UI 라벨 매핑 — analytics-core로 이동하지 않음(통계 분석에 쓰이지 않는 순수 표시용).
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
    unconfirmed: '상병 미확인',
    ageMild: '연령대비 경미',
    mild: '상병 미확인/연령대비 경미', // 레거시(구 데이터 표시용)
    delayed: '업무중단 후 상당기간 경과',
    lowBurden: '누적 신체부담 낮음',
    belowThreshold: '부담 정도가 최소 문턱값을 넘지 못함',
    other: `기타 (${other || ''})`
  };
  return reasons.map(r => reasonMap[r] || r).join('\n');
};
