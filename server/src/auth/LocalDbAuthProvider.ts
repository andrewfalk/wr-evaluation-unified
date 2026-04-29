import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import type { AuthProvider, UserCredentials } from './AuthProvider';

// Precomputed cost-12 bcrypt hash used for constant-time comparison when the
// user is not found or is disabled, preventing timing-based enumeration.
// Must be a real bcrypt hash so bcrypt.compare takes the full ~190ms.
const DUMMY_HASH = '$2b$12$myqU8KWBckwmVrNxYaZndOoWQo.3bbvMNTID7jpYSxBAPb.Zmy5uW';

interface UserRow {
  id:                   string;
  password_hash:        string;
  organization_id:      string | null;
  role:                 string;
  name:                 string;
  must_change_password: boolean;
  disabled_at:          string | null;
}

export class LocalDbAuthProvider implements AuthProvider {
  constructor(private readonly pool: Pool) {}

  async verifyCredentials(loginId: string, password: string): Promise<UserCredentials | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT id, password_hash, organization_id, role, name, must_change_password, disabled_at
       FROM users WHERE login_id = $1`,
      [loginId]
    );

    if (rows.length === 0) {
      // Always run bcrypt to avoid timing-based user enumeration
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }

    const user = rows[0];

    if (user.disabled_at !== null) {
      await bcrypt.compare(password, DUMMY_HASH);
      return null;
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return null;

    return {
      userId:              user.id,
      organizationId:      user.organization_id,
      role:                user.role,
      name:                user.name,
      mustChangePassword:  user.must_change_password,
    };
  }
}
