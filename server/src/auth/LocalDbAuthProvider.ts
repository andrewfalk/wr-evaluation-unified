import bcrypt from 'bcrypt';
import type { Pool } from 'pg';
import type { AuthProvider, UserCredentials } from './AuthProvider';

// Dummy hash used for constant-time comparison when user is not found,
// preventing timing-based user enumeration attacks.
const DUMMY_HASH = '$2b$12$invalidhashinvalidhashinvalidh.invalidhashinvalidhashXX';

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
