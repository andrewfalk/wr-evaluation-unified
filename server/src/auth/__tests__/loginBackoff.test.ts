// loginIdHash normalisation (SEC-B M2): the backoff key must not change with case, surrounding spaces
// or Unicode composition, and must not contain the login ID itself.
import { describe, expect, it } from 'vitest';
import { loginIdHash } from '../loginBackoff';

describe('loginIdHash', () => {
  it('is a 64-character sha256 hex digest', () => {
    expect(loginIdHash('doc1')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('ignores case and surrounding whitespace', () => {
    expect(loginIdHash('  Doc1\t')).toBe(loginIdHash('doc1'));
  });

  it('treats NFC and NFD forms of the same text as one ID', () => {
    const nfc = '김의사'.normalize('NFC');
    const nfd = '김의사'.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(loginIdHash(nfd)).toBe(loginIdHash(nfc));
  });

  it('different IDs get different keys', () => {
    expect(loginIdHash('doc1')).not.toBe(loginIdHash('doc2'));
  });
});
