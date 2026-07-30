// EMR 필드는 CP949(EUC-KR) 기준 바이트 한도를 쓴다(한글 등 2바이트, ASCII 1바이트).
// UTF-8(Blob) 기준으로 세면 한글이 3바이트라 실제 EMR 한도보다 일찍 잘린다 → CP949 근사로 계산.
// 한계: emoji 등 CP949 미지원 문자는 실제 EMR 처리와 다를 수 있으나, 소견서 텍스트(한글+숫자+기호)에선 무관.

export const EMR_TEXT_LIMIT_BYTES = 3950;

export function cp949CharBytes(ch) {
  return ch.codePointAt(0) <= 0x7F ? 1 : 2;
}

export function cp949ByteLength(str) {
  let n = 0;
  for (const ch of String(str || '')) n += cp949CharBytes(ch);
  return n;
}

export function truncateCp949Bytes(str, maxBytes, suffix = '\n...(이하 생략)') {
  if (!str) return { text: '', truncated: false };

  const totalBytes = cp949ByteLength(str);
  if (totalBytes <= maxBytes) return { text: str, truncated: false };

  const limit = maxBytes - cp949ByteLength(suffix);
  let bytes = 0;
  let cutIndex = 0;
  for (const ch of str) {
    const charBytes = cp949CharBytes(ch);
    if (bytes + charBytes > limit) break;
    bytes += charBytes;
    cutIndex += ch.length;
  }

  return { text: str.slice(0, cutIndex) + suffix, truncated: true };
}

// 미리보기 byte 게이지 상태. bytes > limit(초과)를 반올림한 백분율이 아니라 실제 byte로
// 판정한다 — 예: 3,951byte(한도 3,950)는 반올림하면 100%라 "주의"로 보이지만 실제로는
// truncateCp949Bytes가 이미 자르는 초과 상태다.
export function classifyEmrByteStatus(bytes, limit = EMR_TEXT_LIMIT_BYTES) {
  if (bytes > limit) return 'danger';
  if (bytes / limit >= 0.9) return 'warn';
  return 'ok';
}
