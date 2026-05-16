-- Custom job presets: private (owner only) or organization (all org members).
-- Soft-deleted rows retain audit trail; hard cleanup is out of scope for Phase 5.
CREATE TABLE IF NOT EXISTS custom_presets (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID        NOT NULL REFERENCES organizations(id),
  owner_user_id   UUID        NOT NULL REFERENCES users(id),
  job_name        TEXT        NOT NULL,
  category        TEXT        NOT NULL DEFAULT '미분류',
  description     TEXT        NOT NULL DEFAULT '',
  visibility      TEXT        NOT NULL DEFAULT 'private'
                              CHECK (visibility IN ('private', 'organization')),
  revision        INTEGER     NOT NULL DEFAULT 1,
  modules         JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

-- List query: owner's private presets + org-visible presets
CREATE INDEX idx_custom_presets_org_owner
  ON custom_presets (organization_id, owner_user_id)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_custom_presets_org_visibility
  ON custom_presets (organization_id, visibility)
  WHERE deleted_at IS NULL;
