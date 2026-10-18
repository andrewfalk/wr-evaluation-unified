import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import { UPDATE_SIGNING_PUBLIC_KEYS } from '../updateSigningPublicKey.js';

// 이 목록은 셸이 업데이트를 신뢰하는 근거(신뢰의 뿌리)다. 바꾸는 변경은 리뷰에서 지문을 확인하고 여기 기대값도 함께 바꾼다.
const EXPECTED_FINGERPRINTS = [
  'f87a108f5a2488c5b85563fe578555248ee05898707e58875fdfe7f0511a69f6', // 2026-10-18 등록, SHA-256(SPKI DER)
];

const fingerprint = (pem) => crypto.createHash('sha256')
  .update(crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }))
  .digest('hex');

describe('UPDATE_SIGNING_PUBLIC_KEYS (신뢰의 뿌리)', () => {
  it('비어 있지 않다 — 비어 있으면 셸이 모든 업데이트를 거부해 자동 업데이트가 멈춘다', () => {
    expect(UPDATE_SIGNING_PUBLIC_KEYS.length).toBeGreaterThan(0);
  });

  it('모든 항목이 유효한 Ed25519 공개 키(SPKI)다', () => {
    for (const pem of UPDATE_SIGNING_PUBLIC_KEYS) {
      const key = crypto.createPublicKey(pem);
      expect(key.type).toBe('public');
      expect(key.asymmetricKeyType).toBe('ed25519');
      expect(key.export({ type: 'spki', format: 'der' })).toHaveLength(44);
    }
  });

  it('비밀 키 자료가 들어 있지 않다', () => {
    for (const pem of UPDATE_SIGNING_PUBLIC_KEYS) {
      expect(pem).toContain('BEGIN PUBLIC KEY');
      expect(pem).not.toMatch(/PRIVATE KEY/);
    }
  });

  it('중복된 키가 없다', () => {
    const prints = UPDATE_SIGNING_PUBLIC_KEYS.map(fingerprint);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it('등록된 키의 지문이 기대값과 정확히 같다 — 신뢰하는 키가 의도 없이 바뀌면 이 테스트가 실패한다', () => {
    expect(UPDATE_SIGNING_PUBLIC_KEYS.map(fingerprint)).toEqual(EXPECTED_FINGERPRINTS);
  });
});
