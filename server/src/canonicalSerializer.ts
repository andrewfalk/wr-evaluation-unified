// PR0-C §G — digest 계산의 단일 진실원. `JSON.stringify()`로 만들지 않는다(마스터 계획서
// §1.3) — object key 정렬·배열 정렬 기준·Unicode 정규화·-0/NaN/Infinity 처리·숫자 포맷을
// 전부 여기서 고정한다. `node:crypto`를 쓰므로 서버 전용이다 — packages/analytics-core는
// 브라우저 번들에도 들어가 Node 전용 API를 못 쓴다(noNodeApiUsage.test.ts가 소스 스캔으로
// 차단).
import { createHash } from 'crypto';

export class CanonicalSerializeError extends Error {}

function normalizeNumber(x: number): number {
  if (!Number.isFinite(x)) {
    // NaN/Infinity/-Infinity — 조용히 인코딩하면 상류 버그(extractor의 최종 NaN 가드가
    // 이미 방어했어야 할 값)를 숨긴다. 여기 도달했다는 사실 자체가 신호다.
    throw new CanonicalSerializeError(`canonicalSerialize: non-finite number (${x}) is not allowed`);
  }
  // -0과 0은 동일하게 직렬화한다(같은 논리적 값).
  return Object.is(x, -0) ? 0 : x;
}

function serializeObject(obj: Record<string, unknown>): string {
  // 정규화 후 키 충돌 검사 — Map 삽입 순서로 "먼저 나온 원본 키"가 이기지 않고 즉시 throw.
  const normalized = new Map<string, unknown>();
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = rawKey.normalize('NFC');
    if (normalized.has(key)) {
      throw new CanonicalSerializeError(
        `canonicalSerialize: normalized key collision — "${rawKey}" normalizes to an already-used key "${key}"`,
      );
    }
    normalized.set(key, val);
  }
  // 정규화된 키를 UTF-16 code unit 순서로 정렬 — 이 정렬이 없으면 object 프로퍼티 삽입
  // 순서에 따라 같은 논리적 내용이 다른 digest를 낼 수 있다.
  const sortedKeys = Array.from(normalized.keys()).sort();
  const parts = sortedKeys.map((key) => `${JSON.stringify(key)}:${serializeValue(normalized.get(key))}`);
  return `{${parts.join(',')}}`;
}

function serializeValue(value: unknown): string {
  if (value === undefined) {
    throw new CanonicalSerializeError('canonicalSerialize: undefined is not allowed');
  }
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return normalizeNumber(value).toString();
  if (typeof value === 'string') {
    // 문자열 leaf 값도 NFC 정규화 — 같은 의미의 문자열이 입력 경로에 따라 다른 digest를
    // 내는 것을 막는다.
    return JSON.stringify(value.normalize('NFC'));
  }
  if (value instanceof Date) {
    throw new CanonicalSerializeError(
      'canonicalSerialize: Date instances are not allowed — convert to an ISO-8601 string first',
    );
  }
  if (Array.isArray(value)) {
    // 배열은 재정렬하지 않는다 — 호출자가 이미 의미 있는 순서로 정렬해서 넘겨야 한다는 계약.
    return `[${value.map((v) => serializeValue(v)).join(',')}]`;
  }
  if (typeof value === 'object') {
    return serializeObject(value as Record<string, unknown>);
  }
  throw new CanonicalSerializeError(`canonicalSerialize: unsupported value type (${typeof value})`);
}

export function canonicalSerialize(value: unknown): string {
  return serializeValue(value);
}

export function canonicalDigest(value: unknown): string {
  return createHash('sha256').update(canonicalSerialize(value)).digest('hex');
}

// PR0-C run manifest(§1.2)의 serializerVersion. 위 규칙(정렬 기준·정규화·숫자 포맷 등)이
// 바뀌면 이 값을 올린다 — 과거에 계산된 digest와 새 구현의 digest를 같은 것으로 취급하면
// 안 되기 때문.
export const SERIALIZER_VERSION = 'v1';
