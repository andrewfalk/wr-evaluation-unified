import bcrypt from 'bcrypt';

const MIN_LENGTH        = 10;
const MAX_HISTORY       = 5;

// Requires at least one letter, one digit, and one special character.
const HAS_LETTER        = /[a-zA-Z가-힣]/;
const HAS_DIGIT         = /\d/;
const HAS_SPECIAL       = /[^a-zA-Z0-9가-힣]/;

export interface PasswordPolicyResult {
  ok:    boolean;
  error: string | null;
}

export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  if (password.length < MIN_LENGTH) {
    return { ok: false, error: `비밀번호는 최소 ${MIN_LENGTH}자 이상이어야 합니다.` };
  }
  if (!HAS_LETTER.test(password)) {
    return { ok: false, error: '비밀번호에 문자(영문 또는 한글)가 포함되어야 합니다.' };
  }
  if (!HAS_DIGIT.test(password)) {
    return { ok: false, error: '비밀번호에 숫자가 포함되어야 합니다.' };
  }
  if (!HAS_SPECIAL.test(password)) {
    return { ok: false, error: '비밀번호에 특수문자가 포함되어야 합니다.' };
  }
  return { ok: true, error: null };
}

// Returns true if the new password matches any of the recent hashes.
export async function isPasswordReused(
  newPassword:    string,
  historyHashes:  string[]
): Promise<boolean> {
  for (const hash of historyHashes.slice(-MAX_HISTORY)) {
    if (await bcrypt.compare(newPassword, hash)) return true;
  }
  return false;
}

export function appendPasswordHistory(
  historyHashes: string[],
  newHash:       string
): string[] {
  const updated = [...historyHashes, newHash];
  return updated.slice(-MAX_HISTORY);
}
