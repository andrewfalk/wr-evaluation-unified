// PR0-B2: 계산 함수는 packages/analytics-core/modules/shoulder로 이관됐다(knee 전례 그대로).
// 이 파일은 옛 import 경로(계산식 호출부)를 그대로 유지하기 위한 re-export shim이다.
// calculateAge/calculateBMI는 원본 파일도 재export했지만 이 경로로 가져다 쓰는 소비자가
// 없었다(grep 확인) — shoulder 모듈이 export하지 않는 이름이라 Docker 프로덕션 빌드(Vite/
// Rollup)에서만 잡히는 오류였고(vitest는 소스를 직접 resolve해 안 잡힘), 빼는 게 맞다.
export {
  EXPOSURE_LIMITS,
  checkExposureLimit,
  computeJobExposures,
  isShoulderAssessmentComplete,
  computeShoulderCalc,
} from '@analytics-core/modules/shoulder/index';

// UI 라벨 매핑 함수 — analytics-core로 이동하지 않음(UI 전용, 계산에 관여 안 함).
export const getSideText = (side) =>
  side === 'right' ? '우측' : side === 'left' ? '좌측' : side === 'both' ? '양측' : '-';

export const getStatusText = (status) =>
  status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';

export const getEllmanText = (ellman) =>
  ellman === 'N/A' ? '해당없음' : ellman || '-';

export const getReasonText = (reasons, other) => {
  if (typeof reasons === 'string') reasons = reasons ? [reasons] : [];
  if (!reasons || reasons.length === 0) return '-';
  const reasonMap = {
    unrelated:   '신체부담과 관련없는 상병',
    unconfirmed: '상병 미확인',
    ageMild:     '연령대비 경미',
    mild:        '상병 미확인/연령대비 경미', // 레거시(구 데이터 표시용)
    delayed:     '업무중단 후 상당기간 경과',
    lowBurden:   '누적 신체부담 낮음',
    belowThreshold: '부담 정도가 최소 문턱값을 넘지 못함',
    other:       `기타 (${other || ''})`,
  };
  return reasons.map(r => reasonMap[r] || r).join('\n');
};
