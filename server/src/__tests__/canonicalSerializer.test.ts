import { describe, it, expect } from 'vitest';
import { canonicalSerialize, canonicalDigest, CanonicalSerializeError } from '../canonicalSerializer';

describe('canonicalSerialize — key ordering', () => {
  it('object 프로퍼티 삽입 순서가 달라도 같은 내용이면 동일 문자열/digest를 낸다', () => {
    const a = { b: 1, a: 2, c: 3 };
    const b = { c: 3, a: 2, b: 1 };
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
    expect(canonicalDigest(a)).toBe(canonicalDigest(b));
  });

  it('중첩 object도 각 레벨에서 키가 정렬된다', () => {
    const a = { z: { y: 1, x: 2 }, a: 1 };
    const b = { a: 1, z: { x: 2, y: 1 } };
    expect(canonicalSerialize(a)).toBe(canonicalSerialize(b));
  });
});

describe('canonicalSerialize — NFC 정규화', () => {
  it('키/값 문자열이 NFC로 정규화된 뒤 비교되어 동일 digest를 낸다', () => {
    // "é" 조합형(U+00E9)과 분해형(e + U+0301 결합 억음악센트)은 시각적으로 같지만 다른
    // 코드포인트 시퀀스다 — NFC 정규화 없이는 다른 digest를 낸다.
    const composed = 'é';
    const decomposed = 'é';
    expect(composed).not.toBe(decomposed);
    expect(canonicalSerialize({ [composed]: 'v' })).toBe(canonicalSerialize({ [decomposed]: 'v' }));
    expect(canonicalSerialize({ k: composed })).toBe(canonicalSerialize({ k: decomposed }));
  });

  it('정규화 후 서로 다른 원본 키가 같아지면 throw한다', () => {
    const obj: Record<string, unknown> = {};
    obj['é'] = 1;
    obj['é'] = 2;
    expect(() => canonicalSerialize(obj)).toThrow(CanonicalSerializeError);
  });
});

describe('canonicalSerialize — 숫자 처리', () => {
  it('-0과 0은 동일하게 직렬화되어 동일 digest를 낸다(throw 아님)', () => {
    expect(canonicalSerialize({ v: -0 })).toBe(canonicalSerialize({ v: 0 }));
    expect(canonicalDigest({ v: -0 })).toBe(canonicalDigest({ v: 0 }));
  });

  it('NaN/Infinity/-Infinity는 throw한다', () => {
    expect(() => canonicalSerialize({ v: NaN })).toThrow(CanonicalSerializeError);
    expect(() => canonicalSerialize({ v: Infinity })).toThrow(CanonicalSerializeError);
    expect(() => canonicalSerialize({ v: -Infinity })).toThrow(CanonicalSerializeError);
  });
});

describe('canonicalSerialize — 그 외 거부/보존 규칙', () => {
  it('undefined는 throw한다', () => {
    expect(() => canonicalSerialize({ v: undefined })).toThrow(CanonicalSerializeError);
  });

  it('Date 인스턴스는 throw한다', () => {
    expect(() => canonicalSerialize({ v: new Date() })).toThrow(CanonicalSerializeError);
  });

  it('배열 순서는 보존된다(재정렬 안 함)', () => {
    expect(canonicalSerialize([3, 1, 2])).not.toBe(canonicalSerialize([1, 2, 3]));
    expect(canonicalSerialize([1, 2, 3])).toBe(canonicalSerialize([1, 2, 3]));
  });
});

describe('canonicalDigest', () => {
  it('sha256 hex(64자)를 반환한다', () => {
    const digest = canonicalDigest({ a: 1 });
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
