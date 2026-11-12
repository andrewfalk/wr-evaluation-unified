-- 0042 — queue namespace (REFACTORING_ROADMAP S8). Server instances that share one database (e.g. a native
-- development server and the docker app both on wr_evaluation, or development servers of several worktrees)
-- must not claim, sweep, cancel, clean up or reuse each other's statistics runs and video analysis jobs.
-- Every row records the namespace of the instance that created it (config QUEUE_NAMESPACE, default
-- 'default' — the value every existing row gets, so a single production instance behaves as before).
--
-- The two unique indexes move to (organization_id, execution_digest, queue_namespace) in the same release
-- as the code whose ON CONFLICT names that target (runAdmission.ts) — the old two-column ON CONFLICT has
-- no matching index once this runs (42P10). Stop every server that uses the database before updating.

ALTER TABLE stats_runs
  ADD COLUMN queue_namespace TEXT NOT NULL DEFAULT 'default',
  ADD COLUMN claimed_by      TEXT;

DROP INDEX stats_runs_inflight_uniq;
CREATE UNIQUE INDEX stats_runs_inflight_uniq
  ON stats_runs (organization_id, execution_digest, queue_namespace)
  WHERE status IN ('queued','running');

DROP INDEX stats_runs_succeeded_uniq;
CREATE UNIQUE INDEX stats_runs_succeeded_uniq
  ON stats_runs (organization_id, execution_digest, queue_namespace)
  WHERE status = 'succeeded' AND cacheable;

DROP INDEX stats_runs_queue_claim;
CREATE INDEX stats_runs_queue_claim ON stats_runs (queue_namespace, created_at) WHERE status = 'queued';

ALTER TABLE video_analysis_clips ADD COLUMN queue_namespace TEXT NOT NULL DEFAULT 'default';
ALTER TABLE video_analysis_jobs  ADD COLUMN queue_namespace TEXT NOT NULL DEFAULT 'default';

CREATE INDEX video_analysis_jobs_queue_claim ON video_analysis_jobs (queue_namespace, created_at) WHERE status = 'queued';
