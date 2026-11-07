// auth/passwordPolicy.ts — new-password rules (SEC-A L6: maximum 128 characters).
import { describe, expect, it } from 'vitest';
import { checkPasswordPolicy, MAX_PASSWORD_LENGTH } from '../passwordPolicy';

// letter + digit + special, padded to the wanted length
const pw = (length: number): string => ('Aa1!' + 'x'.repeat(Math.max(0, length - 4))).slice(0, length);

describe('checkPasswordPolicy', () => {
  it('accepts 10..128 characters', () => {
    expect(MAX_PASSWORD_LENGTH).toBe(128);
    expect(checkPasswordPolicy(pw(10))).toEqual({ ok: true, error: null });
    expect(checkPasswordPolicy(pw(128))).toEqual({ ok: true, error: null });
  });

  it('rejects more than 128 characters', () => {
    expect(checkPasswordPolicy(pw(129))).toEqual({ ok: false, error: '비밀번호는 최대 128자까지 사용할 수 있습니다.' });
    expect(checkPasswordPolicy(pw(300)).ok).toBe(false);
  });

  it('keeps the existing rules (minimum length, letter, digit, special)', () => {
    expect(checkPasswordPolicy('Aa1!').ok).toBe(false);
    expect(checkPasswordPolicy('1234567890!').ok).toBe(false);
    expect(checkPasswordPolicy('abcdefghij!').ok).toBe(false);
    expect(checkPasswordPolicy('abcdefghij1').ok).toBe(false);
  });
});
