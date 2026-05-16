-- Signup requests submitted from the login page; admins approve/reject in the
-- admin console.  Approval creates the actual user account with a temp password.
CREATE TABLE IF NOT EXISTS user_signup_requests (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id       TEXT         NOT NULL,
  name           TEXT         NOT NULL,
  requested_role TEXT         NOT NULL CHECK (requested_role IN ('doctor', 'nurse', 'staff')),
  note           TEXT,
  status         TEXT         NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by    UUID         REFERENCES users(id),
  reviewed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Only one pending request per login_id is allowed at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signup_requests_login_id_pending
  ON user_signup_requests (login_id)
  WHERE status = 'pending';
