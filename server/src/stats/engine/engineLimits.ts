// PR1 계획서 §1.1/§7.3 — stats-engine 입력 상한. services/stats-engine/protocol.py의
// 같은 이름 리터럴과 값이 반드시 일치해야 한다(대조 테스트: __tests__/statsEngineLimits.
// consistency.test.ts). 이 세 값은 PR1에서 환경변수로 바꿀 수 없다 — Node가 이 값을
// env로 바꾸면 Python의 하드코딩된 jsonschema와 어긋나 "관리자가 상한을 올렸을 뿐인데
// 정상 요청이 PROCESS_ERROR로 죽는" 결함이 생긴다. 바꾸려면 이 파일과 protocol.py를
// 함께 코드 변경+재배포해야 한다.
export const MAX_VALUES_PER_VARIABLE = 50000;
export const MAX_TOTAL_VALUES = 350000;
export const MAX_STRING_LENGTH = 200;
// PR4-A2 — spline 부분효과 그리드 상한(계획서 §2 "예측 그리드(약 40점)").
export const MAX_SPLINE_CONTRAST_POINTS = 60;
// Table1 스트라티피케이션 — 그룹(열) 개수 상한. total 그룹이 이미 전체 rows를
// 담고 나머지 그룹은 그걸 파티션할 뿐이라 그룹 수 자체는 페이로드 크기에 거의
// 영향이 없다(변수당 전송량은 그룹 수와 무관하게 약 2×관측수 — MAX_TOTAL_VALUES가
// 이미 방어). 이 상한은 표 폭(UX) 방어 목적이다. Python protocol.py와 동기화할
// 필요 없음(엔진에 그룹 개념 자체가 없다).
export const MAX_STRATIFY_GROUPS = 20;
