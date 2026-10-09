-- 제한데이터(stats.export_limited_rows) 권한자의 소수 셀(1~9명) 해제본을 "실행 시점에" 저장하는 컬럼.
-- 상관행렬·예측은 성공 직후 frozen_dataset(원본 행)을 지우므로(statsRunsQueue.ts frozenDatasetAfterSuccess)
-- 기술통계·회귀·이변량처럼 조회 때 원본으로 다시 계산할 수 없다 — 예측은 계산에 수 분이 걸려 조회 경로에서 재계산도
-- 못 한다. 그래서 권한자가 실행한 경우에만 워커가 엔진을 한 번 돌려 일반본(result)과 해제본(limited_result)을
-- 함께 만든다.
--
-- 보안 불변식:
--  - limited_result는 STATS_RUN_COLUMNS(일반 SELECT 컬럼 목록)에 넣지 않는다. 조회자의 현재 권한을 확인한 뒤
--    전용 접근자(statsStoredLimited.ts)로만 읽는다. 일반 GET·CSV export·캐시 hit 경로는 이 컬럼을 읽지 않는다.
--  - 행과 함께 expires_at 이후 statsRunCleanup이 통째로 삭제한다(별도 보존기간 없음).
ALTER TABLE stats_runs ADD COLUMN limited_result JSONB;

-- 해제본은 성공한 실행에만 있다.
ALTER TABLE stats_runs ADD CONSTRAINT stats_runs_limited_result_succeeded CHECK (
  limited_result IS NULL OR status = 'succeeded'
);

-- 요청 시점에 권한자였던 상관행렬·예측 실행은 'lift_eligible'이다. 이 값이 execution_digest 입력이라
-- 권한자 실행과 비권한자 실행은 캐시·in-flight 합류가 섞이지 않는다(statsExecutionDigest.ts).
-- 기존 행은 전부 'aggregate'다(0031이 상수로만 써 왔다).
ALTER TABLE stats_runs ADD CONSTRAINT stats_runs_disclosure_profile_check CHECK (
  requested_disclosure_profile IN ('aggregate', 'lift_eligible')
);
