// 업무관련성 평가 어휘 — 종합소견(평가) 화면·일괄 내보내기·일괄 가져오기·소견 그룹이 같이 쓰는 선택지와 문구
// (REFACTORING_ROADMAP Phase 2 C6, P2-52). 예전에는 core가 무릎 모듈(knee/utils/data.js·calculations.js)의 것을 빌려 썼다 —
// 값·식은 그 무릎 것 그대로다. K-L 등급 선택지는 core가 무릎 상병에만 그리지만 ELLMAN_OPTIONS(AssessmentTab.jsx)처럼 core에 둔다
// (레지스트리 조회로 바꾸면 모듈을 등록하지 않는 화면 테스트가 깨진다).
// 아무것도 import하지 않는다(순환 import 방지).

export interface VocabularyOption {
  readonly value: string;
  readonly label: string;
}

/** 무릎 K-L 등급 선택지. */
export const KLG_OPTIONS: readonly VocabularyOption[] = [
  { value: '', label: '선택' },
  { value: 'N/A', label: '해당없음' },
  { value: '1', label: '1등급' },
  { value: '2', label: '2등급' },
  { value: '3', label: '3등급' },
  { value: '4', label: '4등급' },
];

/** 업무관련성 평가 낮음 사유 선택지. */
export const LOW_REASON_OPTIONS: readonly VocabularyOption[] = [
  { value: 'unrelated', label: '신체부담과 관련없는 상병' },
  { value: 'unconfirmed', label: '상병 미확인' },
  { value: 'ageMild', label: '연령대비 경미' },
  { value: 'delayed', label: '업무중단 후 상당기간 경과' },
  { value: 'lowBurden', label: '누적 신체부담 낮음' },
  { value: 'belowThreshold', label: '부담 정도가 최소 문턱값을 넘지 못함' },
  { value: 'other', label: '기타' },
];

/** 상병 상태 문구: confirmed → 확인, unconfirmed → 미확인, 그 밖 → '-' */
export function getStatusText(status: unknown): string {
  return status === 'confirmed' ? '확인' : status === 'unconfirmed' ? '미확인' : '-';
}

/** 낮음 사유 코드 목록(또는 코드 하나)을 줄바꿈으로 이은 문구. 모르는 코드는 그대로, 비어 있으면 '-'. */
export function getReasonText(reasons: string | readonly string[] | null | undefined, other?: string | null): string {
  const list = typeof reasons === 'string' ? (reasons ? [reasons] : []) : reasons;
  if (!list || list.length === 0) return '-';
  const reasonMap: Record<string, string> = {
    unrelated: '신체부담과 관련없는 상병',
    unconfirmed: '상병 미확인',
    ageMild: '연령대비 경미',
    mild: '상병 미확인/연령대비 경미', // 레거시(구 데이터 표시용)
    delayed: '업무중단 후 상당기간 경과',
    lowBurden: '누적 신체부담 낮음',
    belowThreshold: '부담 정도가 최소 문턱값을 넘지 못함',
    other: `기타 (${other || ''})`,
  };
  return list.map(reason => reasonMap[reason] || reason).join('\n');
}
