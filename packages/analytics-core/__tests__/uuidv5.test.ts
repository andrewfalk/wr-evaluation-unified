import { describe, it, expect } from 'vitest';
import { sha1Hex, uuidv5, deterministicJobId, ANALYTICS_CORE_JOB_NAMESPACE } from '../migration/uuidv5';

function bytesOf(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

describe('sha1Hex — NIST/FIPS 180-1 public test vectors', () => {
  it('single block: SHA-1("abc")', () => {
    // 계획서 초안(§6.2)에 트랜스크립션 오타(끝자리 d 누락)가 있었다 — 실구현으로
    // 재검증한 정확한 값. 표준 그룹핑: a9993e36 4706816a ba3e2571 7850c26c 9cd0d89d
    expect(sha1Hex(bytesOf('abc'))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
  });

  it('empty string', () => {
    expect(sha1Hex(bytesOf(''))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
  });

  it('multi-block (56-byte message, crosses the 55-byte single-block boundary)', () => {
    expect(sha1Hex(bytesOf('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))).toBe(
      '84983e441c3bd26ebaae4aa1f95129e5e54670f1',
    );
  });
});

describe('uuidv5 — RFC4122 §4.3 construction', () => {
  it('matches the well-known public NAMESPACE_DNS + "www.example.com" example', () => {
    expect(uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('produces a syntactically valid UUID with version=5 and RFC4122 variant bits', () => {
    const id = uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, 'some-name');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('is deterministic — same namespace+name always yields the same UUID', () => {
    const a = uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, 'case-1:job:0');
    const b = uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, 'case-1:job:0');
    expect(a).toBe(b);
  });

  it('different names yield different UUIDs', () => {
    const a = uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, 'case-1:job:0');
    const b = uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, 'case-1:job:1');
    expect(a).not.toBe(b);
  });
});

describe('deterministicJobId', () => {
  it('is deterministic across repeated calls with the same caseId/index', () => {
    expect(deterministicJobId('case-42', 3)).toBe(deterministicJobId('case-42', 3));
  });

  it('differs by caseId and by legacyIndex', () => {
    expect(deterministicJobId('case-42', 0)).not.toBe(deterministicJobId('case-43', 0));
    expect(deterministicJobId('case-42', 0)).not.toBe(deterministicJobId('case-42', 1));
  });
});
