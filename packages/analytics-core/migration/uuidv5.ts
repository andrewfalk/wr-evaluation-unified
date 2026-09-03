// 순수 TypeScript SHA-1 + UUIDv5(RFC4122 §4.3). `node:crypto`를 쓰지 않는다 — 이 패키지는
// 브라우저 번들에도 들어가는데 `node:crypto`는 Node 전용 API라 Vite 브라우저 빌드에서
// 깨진다(§핵심 제약). `crypto.subtle`(Web Crypto)도 쓰지 않는다 — 비동기라 마이그레이션을
// 동기 함수로 유지할 수 없게 만든다.
//
// 검증: __tests__/uuidv5.test.ts가 SHA-1 단일/멀티 블록 표준 벡터와 공개 UUIDv5 예시로
// 이 구현 자체를 고정한다. 이 패키지 고유 namespace(ANALYTICS_CORE_JOB_NAMESPACE)의 실제
// 출력엔 "정답"이 없으므로, Node·Chromium에서 동일 입력에 동일 출력을 내는지가 실제 합격
// 기준이다(browserParity/knee.spec.ts).

function toUtf8Bytes(str: string): Uint8Array {
  // TextEncoder는 Node·모든 현대 브라우저(윈도7 상한 Chrome 109 포함) 표준 전역이라
  // Node 전용도 브라우저 전용도 아니다 — 이 패키지의 "환경 API 금지"는 Node 전용 API에
  // 대한 것이지, 두 환경 모두가 제공하는 표준 API까지 배제하는 게 아니다.
  return new TextEncoder().encode(str);
}

function rotl(x: number, n: number): number {
  return ((x << n) | (x >>> (32 - n))) >>> 0;
}

/** 표준 SHA-1(FIPS 180-1). 입력 바이트 배열 → 20바이트 다이제스트. */
export function sha1(message: Uint8Array): Uint8Array {
  const msgLenBits = message.length * 8;

  // 패딩: 0x80 한 바이트 + 0 채우기 + 64비트 빅엔디안 길이(비트 단위), 총 길이는 64바이트 배수.
  const withOnePad = message.length + 1;
  const padZeros = ((56 - (withOnePad % 64)) + 64) % 64;
  const totalLen = withOnePad + padZeros + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(message, 0);
  padded[message.length] = 0x80;
  // 길이는 2^53비트 미만(이 패키지의 seed 문자열 길이로는 절대 도달 불가)이라 상위 32비트는 0으로 둔다.
  const lenHi = Math.floor(msgLenBits / 0x100000000) >>> 0;
  const lenLo = msgLenBits >>> 0;
  const lenOffset = totalLen - 8;
  padded[lenOffset] = (lenHi >>> 24) & 0xff;
  padded[lenOffset + 1] = (lenHi >>> 16) & 0xff;
  padded[lenOffset + 2] = (lenHi >>> 8) & 0xff;
  padded[lenOffset + 3] = lenHi & 0xff;
  padded[lenOffset + 4] = (lenLo >>> 24) & 0xff;
  padded[lenOffset + 5] = (lenLo >>> 16) & 0xff;
  padded[lenOffset + 6] = (lenLo >>> 8) & 0xff;
  padded[lenOffset + 7] = lenLo & 0xff;

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;

  const w = new Int32Array(80);

  for (let chunkStart = 0; chunkStart < totalLen; chunkStart += 64) {
    for (let i = 0; i < 16; i++) {
      const o = chunkStart + i * 4;
      w[i] =
        ((padded[o] << 24) | (padded[o + 1] << 16) | (padded[o + 2] << 8) | padded[o + 3]) | 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;

    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30);
      b = a;
      a = temp;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }

  const out = new Uint8Array(20);
  const words = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++) {
    out[i * 4] = (words[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 3] = words[i] & 0xff;
  }
  return out;
}

export function sha1Hex(message: Uint8Array): string {
  return Array.from(sha1(message))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function parseUuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, '');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}

/** RFC4122 §4.3 UUIDv5(name-based, SHA-1). namespace는 UUID 문자열, name은 임의 문자열. */
export function uuidv5(namespace: string, name: string): string {
  const nsBytes = parseUuidToBytes(namespace);
  const nameBytes = toUtf8Bytes(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);

  const hash = sha1(input);
  const bytes = hash.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC4122

  return bytesToUuid(bytes);
}

// 이 패키지 전용 고정 namespace. 절대 변경 금지 — 바뀌면 기존에 합성된 결정적 job id가 전부 바뀐다.
export const ANALYTICS_CORE_JOB_NAMESPACE = 'f47b3c92-8e11-4d6a-9c3f-2a7b5e9d1c40';

/** caseId + legacy job index로부터 결정적 UUID를 합성한다(§3.1 runEntityKey의 최소 적용). */
export function deterministicJobId(caseId: string, legacyIndex: number): string {
  return uuidv5(ANALYTICS_CORE_JOB_NAMESPACE, `${caseId}:job:${legacyIndex}`);
}
