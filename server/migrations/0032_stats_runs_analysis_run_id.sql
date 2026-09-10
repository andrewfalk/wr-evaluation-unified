-- PR2 §7 — stats_runs.manifest 안의 analysisRunId(애플리케이션 randomUUID(), statsRunManifest.ts)는
-- stats_runs.id(DB gen_random_uuid() 기본값)와 서로 다른 값이다. 클라이언트는 manifest.analysisRunId만
-- 알고 있으므로, export(POST /api/stats/export)가 그 값으로 조회할 수 있는 컬럼을 만든다.
ALTER TABLE stats_runs ADD COLUMN analysis_run_id UUID;

UPDATE stats_runs
   SET analysis_run_id = (manifest->>'analysisRunId')::uuid
 WHERE analysis_run_id IS NULL;

ALTER TABLE stats_runs ALTER COLUMN analysis_run_id SET NOT NULL;

-- 조직 범위 안에서만 유일 — analysisRunId는 randomUUID()라 사실상 전역으로도 유일하지만,
-- export 조회를 organization_id로도 거르므로 조회 계획이 이 복합 인덱스를 그대로 쓴다.
CREATE UNIQUE INDEX stats_runs_analysis_run_id_uniq ON stats_runs (organization_id, analysis_run_id);
