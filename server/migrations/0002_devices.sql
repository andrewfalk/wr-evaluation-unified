-- 0002_devices.sql
-- Device registry for EMR audit signing (Ed25519 keypair per Electron install)

CREATE TABLE devices (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES users(id),
  organization_id UUID        REFERENCES organizations(id),
  public_key      TEXT        NOT NULL,
  build_target    TEXT        NOT NULL CHECK (build_target IN ('intranet', 'standalone')),
  status          TEXT        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'active', 'revoked')),
  approved_by     UUID        REFERENCES users(id),
  approved_at     TIMESTAMPTZ,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  last_seen_at    TIMESTAMPTZ,
  register_origin TEXT,
  register_ua     TEXT,
  register_ip     INET
);

CREATE INDEX devices_user_idx   ON devices(user_id);
CREATE INDEX devices_status_idx ON devices(status);
