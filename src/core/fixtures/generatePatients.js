// 결정적 N명 환자 생성기 (REFACTORING_ROADMAP P0-13 성능 기준선 — 화면 렌더링 100·500명 측정용).
//
// 동결된 골든 환자(goldenPatients.json, 29명·6모듈)를 차례로 복제하고 id·환자번호만 바꾼다
// (server G6 골든이 예측 표본을 만들 때 쓰는 방식과 같음). 같은 n이면 항상 같은 결과 — 측정을
// 다시 돌려도(트랙 P 전/후 비교) 입력이 같다. 골든 입력 파일 자체는 바꾸지 않는다.
// 원본은 인자로 받는다 — 측정 스크립트(scripts/perf/render-timing.mjs)는 순수 Node라 JSON import가 안 되므로
// goldenPatients.json을 직접 읽어 넘기고, vitest에서는 loadGoldenPatients()를 넘긴다.

const ID_PREFIX = '00000000-0000-4000-9000-'; // 골든(…-8000-…)과 겹치지 않는 결정적 UUID v4 모양

export function generatedPatientId(index) {
  return `${ID_PREFIX}${String(index + 1).padStart(12, '0')}`;
}

/**
 * @param {number} n 만들 환자 수(0 이상 정수)
 * @param {Array<object>} base 복제 원본(보통 골든 환자 — goldenPatients.json)
 * @returns {Array<object>} n명 — i번째는 base[i % base.length]의 깊은 복사본
 */
export function generatePatients(n, base) {
  if (!Number.isInteger(n) || n < 0) throw new Error(`generatePatients: n must be a non-negative integer (got ${n})`);
  if (!Array.isArray(base) || base.length === 0) throw new Error('generatePatients: base must be a non-empty array');
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const copy = JSON.parse(JSON.stringify(base[i % base.length]));
    copy.id = generatedPatientId(i);
    if (copy.data?.shared) {
      copy.data.shared.patientNo = `WR9${String(i + 1).padStart(5, '0')}`;
    }
    out.push(copy);
  }
  return out;
}
