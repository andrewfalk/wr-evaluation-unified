-- stats.export_limited_rows 표시 이름·설명 갱신(0034 후속). 키는 그대로 — grant 행과
-- 코드의 hasCapability 판정은 영향 없음.
--
-- 범주형 기술통계의 소수 범주 "기타" 병합 PR에서 이 권한이 원본 범주 빈도(rawLevels)까지
-- 열게 되어, 관리자 콘솔 "통계 권한" 탭의 이름을 "원본 히스토그램"만 가리키지 않도록
-- "원본 분포"로 넓힌다.
UPDATE capabilities
SET label = '제한 데이터 열람(원본 값·원본 분포)',
    description = '분석 화면에 소수 인원 보호를 거치지 않은 원본 값을 표시: 이상치 원값·산점도 원시 점·회귀 관측치 진단값·원본 히스토그램·원본 범주 빈도. 응답마다 감사 기록, 결과 캐시에는 저장 안 함. 행 단위 파일 내보내기는 아님'
WHERE key = 'stats.export_limited_rows';
