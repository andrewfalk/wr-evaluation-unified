// 시간 단위 변환 leaf 유틸.
// calculations.js / sectionText.js / vibrationCalc.js가 공용으로 import하며,
// 순환참조를 피하기 위해 다른 spine 유틸을 import하지 않는다.
export function convertTimeToSeconds(value, unit) {
  switch (unit) {
    case 'min': return value * 60;
    case 'hr': return value * 3600;
    default: return value;
  }
}
