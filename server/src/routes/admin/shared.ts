// Helpers shared by several admin route files.
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Signup request helpers
// ---------------------------------------------------------------------------

// Generates a cryptographically random 12-char password meeting policy:
// letter + digit + special + 9 more from the full set, shuffled.
export function generateTempPassword(): string {
  const upper   = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lower   = 'abcdefghijklmnopqrstuvwxyz';
  const digits  = '0123456789';
  const special = '!@#$%^&*';
  const all     = upper + lower + digits + special;
  const pick    = (s: string) => s[randomBytes(1)[0] % s.length];
  const pw      = [
    pick(upper), pick(lower), pick(digits), pick(special),
    ...Array.from({ length: 8 }, () => all[randomBytes(1)[0] % all.length]),
  ];
  for (let i = pw.length - 1; i > 0; i--) {
    const j = randomBytes(1)[0] % (i + 1);
    [pw[i], pw[j]] = [pw[j], pw[i]];
  }
  return pw.join('');
}
