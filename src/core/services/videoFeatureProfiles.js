// 반복 관련 feature의 analysisProfile 게이팅 정책 — single source(§8.9, 6.0-10, 6.0-11, 6.0-16).
// mock 생성(videoMock.js)·요청 생성(videoAnalysisRun.js)·candidate 표시 방어선(VideoAnalysisStep.jsx)이
// 모두 이 파일의 상수를 공유해 프로필 정책이 한 곳에서만 정의되게 한다(리뷰 반영 — 이전엔 videoMock.js에
// 있어 "mock 전용 파일이 profile 정책의 single source"가 되는 어색함이 있었음).

// 반복빈도(어깨·팔꿈치) feature는 fps가 높은 상지반복/손목 profile에서만 의미 있음(저fps는 Nyquist 언더카운트).
// 그 외 profile(자세시간)에서는 산출·표시하지 않는다(6.0-11).
export const REPETITION_FEATURE_KEYS = new Set(['shoulderRepetitionRate', 'elbowRepetitionRate']);
export const REPETITION_PROFILES = new Set(['repetition-upper-limb', 'hand-wrist']);

// 손목 feature(반복+굴곡/편위)는 wholebody pose가 필요 → hand-wrist profile에서만 산출(6.0-10).
export const HAND_WRIST_FEATURE_KEYS = new Set([
  'wristRepetitionRate', 'wristFlexionPeakAngle', 'wristDeviationPeakAngle',
]);

// 6.0-16: 어깨 반복 '밴드별 시간합'(main 2키 repetitiveMedium/FastHours + Left/Right 4키)은
// repetition-upper-limb에서만 산출·표시한다(REPETITION_PROFILES와 달리 hand-wrist는 불허 — 별도 판정).
export const REPETITION_BAND_FEATURE_KEYS = new Set([
  'repetitiveMediumHours', 'repetitiveFastHours',
  'repetitiveMediumHoursLeft', 'repetitiveMediumHoursRight',
  'repetitiveFastHoursLeft', 'repetitiveFastHoursRight',
]);
