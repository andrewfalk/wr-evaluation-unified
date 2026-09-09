// PR1 계획서 §1.1/§7.3 — stats-engine 입력 상한. services/stats-engine/protocol.py의
// 같은 이름 리터럴과 값이 반드시 일치해야 한다(대조 테스트: __tests__/statsEngineLimits.
// consistency.test.ts). 이 세 값은 PR1에서 환경변수로 바꿀 수 없다 — Node가 이 값을
// env로 바꾸면 Python의 하드코딩된 jsonschema와 어긋나 "관리자가 상한을 올렸을 뿐인데
// 정상 요청이 PROCESS_ERROR로 죽는" 결함이 생긴다. 바꾸려면 이 파일과 protocol.py를
// 함께 코드 변경+재배포해야 한다.
export const MAX_VALUES_PER_VARIABLE = 50000;
export const MAX_TOTAL_VALUES = 350000;
export const MAX_STRING_LENGTH = 200;
