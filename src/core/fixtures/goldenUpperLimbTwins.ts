// 팔꿈치·손목 쌍둥이 특성화용 입력 표(P2-67a, Phase 2 C8) — 두 모듈에 **같은 입력**을 흘려 지금 출력을 얼린다.
// 직력 3개(빈 직종명·기간 0·신체부담평가 미포함), 상병 15개(팔꿈치·손목 BK2101/2103/2105/2106/2113 추론, moduleId 지정·
// 평가 제외·무릎·빈 상병), 모듈 상태(옛 형식·프리셋 대기·대표값 복사·보정 규칙), 일괄 가져오기 행 값.
// 합성 데이터다. 손으로 만든 평범한 데이터이고 다시 만들지 않는다 — 사례를 늘릴 때는 덧붙이고 그 PR에서 골든을 갱신한다.
// goldenPatients*.json과 따로 둔 이유는 그 파일들과 같다(서버 골든·성능 스크립트가 읽는 파일의 값을 바꾸지 않으려고).
import inputs from './goldenUpperLimbTwins.json';

export type UpperLimbTwinInputs = typeof inputs;

/** 호출마다 새 깊은 사본 — 시험 대상 함수가 입력을 고치는 경우가 있다(일괄 가져오기 applyRow). */
export function loadUpperLimbTwinInputs(): UpperLimbTwinInputs {
  return JSON.parse(JSON.stringify(inputs)) as UpperLimbTwinInputs;
}
