import { describe, expect, it } from 'vitest';
import crypto from 'crypto';
import yaml from 'js-yaml';
import {
  verifyFeedSignature, verifyFeedForUpdate, checkFeedBeforeDownload, feedFileNames, SIGNATURE_BYTES,
  createDownloadGate, describeRejection,
} from '../updateFeedVerify.js';

const newKeyPair = () => crypto.generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const sign = (bytes, privateKeyPem) => crypto.sign(null, bytes, crypto.createPrivateKey(privateKeyPem)).toString('base64');

const trusted = newKeyPair();
const attacker = newKeyPair();

// electron-builder가 만드는 모양(설치본 이름에 한글이 있어 url은 인코딩돼 있다).
const feedObject = (over = {}) => ({
  version: '7.1.4',
  files: [{ url: encodeURIComponent('통합 평가 Setup 7.1.4.exe'), sha512: 'aGVsbG8tc2hhNTEy', size: 123456 }],
  path: encodeURIComponent('통합 평가 Setup 7.1.4.exe'),
  sha512: 'aGVsbG8tc2hhNTEy',
  releaseDate: '2026-10-18T00:00:00.000Z',
  ...over,
});
const ymlBytes = (obj = feedObject()) => Buffer.from(yaml.dump(obj), 'utf8');
// electron-updater가 하는 방식 그대로: 받은 원문을 js-yaml로 파싱한 객체가 info다.
const infoOf = (bytes) => yaml.load(bytes.toString('utf8'));

describe('verifyFeedSignature', () => {
  it('유효한 서명은 통과한다', () => {
    const bytes = ymlBytes();
    expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sign(bytes, trusted.privateKey), publicKeys: [trusted.publicKey] })).toEqual({ ok: true });
  });

  it('서명 파일 끝의 개행은 무시한다(서명 도구가 개행을 붙여 쓴다)', () => {
    const bytes = ymlBytes();
    const sig = `${sign(bytes, trusted.privateKey)}\r\n`;
    expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys: [trusted.publicKey] }).ok).toBe(true);
  });

  it('yml이 한 바이트라도 바뀌면 거부한다', () => {
    const bytes = ymlBytes();
    const sig = sign(bytes, trusted.privateKey);
    const tampered = Buffer.from(bytes);
    tampered[tampered.length - 2] ^= 0x01;
    expect(verifyFeedSignature({ ymlBytes: tampered, sigBase64: sig, publicKeys: [trusted.publicKey] })).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('설치본 해시를 바꾼 yml을 공격자 키로 다시 서명하면 신뢰 키로는 거부한다', () => {
    const forged = ymlBytes(feedObject({ sha512: 'ZmFrZS1zaGE1MTI=' }));
    const sig = sign(forged, attacker.privateKey);
    expect(verifyFeedSignature({ ymlBytes: forged, sigBase64: sig, publicKeys: [trusted.publicKey] })).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('공개 키 목록이 비어 있으면 열어 두지 않고 거부한다', () => {
    const bytes = ymlBytes();
    const sig = sign(bytes, trusted.privateKey);
    for (const publicKeys of [[], undefined, null]) {
      expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys })).toEqual({ ok: false, reason: 'no-public-key' });
    }
  });

  it('목록의 어느 키로든 맞으면 통과한다(키 교체 과도기)', () => {
    const bytes = ymlBytes();
    const sig = sign(bytes, trusted.privateKey);
    expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys: [attacker.publicKey, trusted.publicKey] }).ok).toBe(true);
  });

  it('목록 안의 잘못된 키 하나가 다른 키의 검증을 막지 않는다', () => {
    const bytes = ymlBytes();
    const sig = sign(bytes, trusted.privateKey);
    expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys: ['not a pem', trusted.publicKey] }).ok).toBe(true);
    expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys: ['not a pem'] })).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it.each([
    ['빈 서명', ''],
    ['undefined', undefined],
    ['짧은 서명', Buffer.alloc(SIGNATURE_BYTES - 1, 1).toString('base64')],
    ['긴 서명', Buffer.alloc(SIGNATURE_BYTES + 1, 1).toString('base64')],
    ['base64가 아닌 글자 섞임', `${Buffer.alloc(SIGNATURE_BYTES, 1).toString('base64')}!!`],
    ['앞에 쓰레기 글자', `@@${Buffer.alloc(SIGNATURE_BYTES, 1).toString('base64')}`],
  ])('형식이 틀린 서명(%s)은 거부한다', (_name, sigBase64) => {
    expect(verifyFeedSignature({ ymlBytes: ymlBytes(), sigBase64, publicKeys: [trusted.publicKey] })).toEqual({ ok: false, reason: 'bad-signature-format' });
  });

  it('yml이 Buffer가 아니면 거부한다', () => {
    expect(verifyFeedSignature({ ymlBytes: 'text', sigBase64: 'x', publicKeys: [trusted.publicKey] })).toEqual({ ok: false, reason: 'invalid-input' });
  });
});

describe('verifyFeedForUpdate', () => {
  const bytes = ymlBytes();
  const sigBase64 = sign(bytes, trusted.privateKey);
  const base = { ymlBytes: bytes, sigBase64, publicKeys: [trusted.publicKey] };

  it('서명이 맞고 electron-updater의 info와 같으면 통과한다', () => {
    expect(verifyFeedForUpdate({ ...base, info: infoOf(bytes) })).toEqual({ ok: true });
  });

  it('electron-updater가 받은 info의 설치본 해시가 서명된 yml과 다르면 거부한다', () => {
    const info = infoOf(ymlBytes(feedObject({ sha512: 'ZmFrZQ==', files: [{ ...feedObject().files[0], sha512: 'ZmFrZQ==' }] })));
    const result = verifyFeedForUpdate({ ...base, info });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('info-mismatch');
    expect(result.differingKeys).toEqual(expect.arrayContaining(['sha512', 'files']));
  });

  it.each([
    ['버전', (o) => ({ ...o, version: '9.9.9' }), ['version']],
    ['설치본 경로', (o) => ({ ...o, path: 'evil.exe' }), ['path']],
    ['파일 url', (o) => ({ ...o, files: [{ ...o.files[0], url: 'evil.exe' }] }), ['files']],
    ['파일 크기', (o) => ({ ...o, files: [{ ...o.files[0], size: 1 }] }), ['files']],
    ['파일 항목 추가', (o) => ({ ...o, files: [...o.files, { url: 'extra.exe', sha512: 'eA==', size: 1 }] }), ['files']],
    ['알 수 없는 필드 추가', (o) => ({ ...o, extra: 'x' }), ['extra']],
    ['필드 삭제', (o) => { const { releaseDate, ...rest } = o; return rest; }, ['releaseDate']],
  ])('info의 %s이(가) 다르면 거부하고 어떤 필드가 다른지 알려 준다', (_name, mutate, differing) => {
    const info = mutate(infoOf(bytes));
    const result = verifyFeedForUpdate({ ...base, info });
    expect(result).toEqual({ ok: false, reason: 'info-mismatch', differingKeys: differing });
  });

  it('info가 없거나 객체가 아니면 거부한다', () => {
    for (const info of [undefined, null, 'x', 42]) {
      expect(verifyFeedForUpdate({ ...base, info }).ok).toBe(false);
    }
  });

  it('서명이 틀리면 YAML을 파싱하기 전에 거부한다 — 서명되지 않은 입력은 파서에 넣지 않는다', () => {
    const garbage = Buffer.from(': : [unterminated {', 'utf8'); // YAML로는 파싱 오류가 나는 입력
    const result = verifyFeedForUpdate({ ymlBytes: garbage, sigBase64, publicKeys: [trusted.publicKey], info: {} });
    // 파싱을 먼저 했다면 'invalid-yaml'이 나온다. 서명 단계에서 끊겨야 한다.
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('서명은 맞지만 YAML이 아니면 invalid-yaml이다', () => {
    const garbage = Buffer.from(': : [unterminated {', 'utf8');
    const result = verifyFeedForUpdate({ ymlBytes: garbage, sigBase64: sign(garbage, trusted.privateKey), publicKeys: [trusted.publicKey], info: {} });
    expect(result).toEqual({ ok: false, reason: 'invalid-yaml' });
  });
});

describe('checkFeedBeforeDownload', () => {
  const bytes = ymlBytes();
  const sigBytes = Buffer.from(`${sign(bytes, trusted.privateKey)}\n`, 'utf8');
  const BASE = 'https://wr.hospital.local:8443/updates';

  function makeFetch(files) {
    const calls = [];
    const fetchBuffer = async (url, maxBytes) => { calls.push({ url, maxBytes }); return files[url] ?? null; };
    return { fetchBuffer, calls };
  }
  const run = (overrides = {}) => checkFeedBeforeDownload({
    feedBaseUrl: BASE, channel: 'latest', info: infoOf(bytes), publicKeys: [trusted.publicKey], ...overrides,
  });

  it('채널의 yml과 서명 파일을 받아 검증하고 통과하면 ok다', async () => {
    const { fetchBuffer, calls } = makeFetch({ [`${BASE}/latest.yml`]: bytes, [`${BASE}/latest.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer })).toEqual({ ok: true });
    expect(calls.map((c) => c.url).sort()).toEqual([`${BASE}/latest.yml`, `${BASE}/latest.yml.sig`]);
    expect(calls.every((c) => Number.isInteger(c.maxBytes) && c.maxBytes > 0)).toBe(true);
  });

  it('canary 채널은 canary.yml과 canary.yml.sig를 받는다', async () => {
    const { fetchBuffer, calls } = makeFetch({ [`${BASE}/canary.yml`]: bytes, [`${BASE}/canary.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer, channel: 'canary' })).toEqual({ ok: true });
    expect(calls.map((c) => c.url).sort()).toEqual([`${BASE}/canary.yml`, `${BASE}/canary.yml.sig`]);
  });

  it('기준 주소 끝의 슬래시는 무시한다', async () => {
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: bytes, [`${BASE}/latest.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer, feedBaseUrl: `${BASE}//` })).toEqual({ ok: true });
  });

  it('서명 파일이 없으면(미서명 피드) 거부한다', async () => {
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: bytes });
    expect(await run({ fetchBuffer })).toEqual({ ok: false, reason: 'signature-file-missing' });
  });

  it('yml을 받지 못하면 거부한다', async () => {
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer })).toEqual({ ok: false, reason: 'feed-unavailable' });
  });

  it('서버가 내려 준 yml이 서명과 다르면(바꿔치기) 거부한다', async () => {
    const forged = ymlBytes(feedObject({ sha512: 'ZmFrZQ==' }));
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: forged, [`${BASE}/latest.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer })).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('공격자가 yml과 서명을 함께 자기 키로 만들어 올려도 거부한다', async () => {
    const forged = ymlBytes(feedObject({ sha512: 'ZmFrZQ==' }));
    const forgedSig = Buffer.from(sign(forged, attacker.privateKey), 'utf8');
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: forged, [`${BASE}/latest.yml.sig`]: forgedSig });
    expect(await run({ fetchBuffer, info: infoOf(forged) })).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('진짜 서명이 붙은 옛 yml을 다시 올린 경우(info와 불일치)도 거부한다', async () => {
    // electron-updater는 지금 서버의 yml(info)을 받았는데, 서명 확인용으로 받은 것은 다른(서명된) yml인 상황.
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: bytes, [`${BASE}/latest.yml.sig`]: sigBytes });
    const result = await run({ fetchBuffer, info: infoOf(ymlBytes(feedObject({ version: '7.1.5' }))) });
    expect(result).toMatchObject({ ok: false, reason: 'info-mismatch' });
  });

  it('공개 키가 없으면 서명이 맞아도 거부한다(fail-closed)', async () => {
    const { fetchBuffer } = makeFetch({ [`${BASE}/latest.yml`]: bytes, [`${BASE}/latest.yml.sig`]: sigBytes });
    expect(await run({ fetchBuffer, publicKeys: [] })).toEqual({ ok: false, reason: 'no-public-key' });
  });
});

describe('createDownloadGate — 검증을 통과해야만 다운로드한다', () => {
  const bytes = ymlBytes();
  const sigBytes = Buffer.from(`${sign(bytes, trusted.privateKey)}\n`, 'utf8');
  const BASE = 'https://wr.hospital.local:8443/updates';
  const goodFiles = { [`${BASE}/latest.yml`]: bytes, [`${BASE}/latest.yml.sig`]: sigBytes };

  function makeGate({ files = goodFiles, publicKeys = [trusted.publicKey], fetchBuffer, channel = 'latest' } = {}) {
    const calls = { download: 0, verified: 0, order: [], rejected: [] };
    const gate = createDownloadGate({
      feedBaseUrl: BASE, channel, publicKeys,
      fetchBuffer: fetchBuffer ?? (async (url) => files[url] ?? null),
      download: () => { calls.download += 1; calls.order.push('download'); },
      onVerified: () => { calls.verified += 1; calls.order.push('verified'); },
      onRejected: (err) => calls.rejected.push(err),
    });
    return { gate, calls };
  }

  it('서명과 info가 모두 맞으면 download를 한 번 부르고 true를 돌려준다', async () => {
    const { gate, calls } = makeGate();
    expect(await gate(infoOf(bytes))).toBe(true);
    expect(calls.download).toBe(1);
    expect(calls.rejected).toHaveLength(0);
  });

  it('검증을 통과하면 onVerified를 한 번, download 직전에 부른다 — 연속 실패 횟수 초기화 같은 "검증 성공" 후속 작업용', async () => {
    const { gate, calls } = makeGate();
    await gate(infoOf(bytes));
    expect(calls.verified).toBe(1);
    expect(calls.order).toEqual(['verified', 'download']);
  });

  it('onVerified는 선택 인자다 — 넘기지 않아도 다운로드한다', async () => {
    let downloads = 0;
    const gate = createDownloadGate({
      feedBaseUrl: BASE, channel: 'latest', publicKeys: [trusted.publicKey],
      fetchBuffer: async (url) => goodFiles[url] ?? null, download: () => { downloads += 1; }, onRejected: () => {},
    });
    expect(await gate(infoOf(bytes))).toBe(true);
    expect(downloads).toBe(1);
  });

  it.each([
    ['서명 파일이 없음(미서명 피드)', { [`${BASE}/latest.yml`]: bytes }, 'signature-file-missing'],
    ['yml을 받지 못함', { [`${BASE}/latest.yml.sig`]: sigBytes }, 'feed-unavailable'],
    ['서버의 yml이 서명 뒤에 바뀜(바꿔치기)', { ...goodFiles, [`${BASE}/latest.yml`]: ymlBytes(feedObject({ sha512: 'ZmFrZQ==' })) }, 'signature-mismatch'],
    ['서명이 다른 키로 만들어짐', { ...goodFiles, [`${BASE}/latest.yml.sig`]: Buffer.from(sign(bytes, attacker.privateKey)) }, 'signature-mismatch'],
  ])('%s → download를 부르지 않고 사유와 함께 거부를 알린다', async (_name, files, reason) => {
    const { gate, calls } = makeGate({ files });
    expect(await gate(infoOf(bytes))).toBe(false);
    expect(calls.download).toBe(0);
    expect(calls.verified).toBe(0); // 거부는 "검증 성공"이 아니므로 연속 실패 횟수가 초기화되면 안 된다
    expect(calls.rejected).toHaveLength(1);
    expect(calls.rejected[0]).toBeInstanceOf(Error);
    expect(calls.rejected[0].message).toBe(`UPDATE_FEED_REJECTED:${reason}`);
  });

  it('공개 키가 없으면(셸에 키가 비어 있음) 서명이 맞아도 다운로드하지 않는다', async () => {
    const { gate, calls } = makeGate({ publicKeys: [] });
    expect(await gate(infoOf(bytes))).toBe(false);
    expect(calls.download).toBe(0);
    expect(calls.verified).toBe(0);
    expect(calls.rejected[0].message).toBe('UPDATE_FEED_REJECTED:no-public-key');
  });

  it('서명은 맞지만 electron-updater가 받은 info가 다르면 거부하고 어느 필드가 다른지 알린다', async () => {
    const { gate, calls } = makeGate();
    expect(await gate({ ...infoOf(bytes), version: '9.9.9' })).toBe(false);
    expect(calls.download).toBe(0);
    expect(calls.verified).toBe(0);
    expect(calls.rejected[0].message).toBe('UPDATE_FEED_REJECTED:info-mismatch(version)');
  });

  it('검증 중 예외(네트워크 계층이 던짐)도 다운로드로 이어지지 않고 거부로 알린다', async () => {
    const { gate, calls } = makeGate({ fetchBuffer: async () => { throw new Error('socket hang up'); } });
    expect(await gate(infoOf(bytes))).toBe(false);
    expect(calls.download).toBe(0);
    expect(calls.verified).toBe(0);
    expect(calls.rejected).toHaveLength(1);
    expect(calls.rejected[0].message).toBe('UPDATE_FEED_REJECTED:verification-error:socket hang up');
  });

  it('동기로 던지는 fetchBuffer도 같다(net.request가 동기 throw할 수 있음)', async () => {
    const { gate, calls } = makeGate({ fetchBuffer: () => { throw new Error('sync throw'); } });
    expect(await gate(infoOf(bytes))).toBe(false);
    expect(calls.download).toBe(0);
    expect(calls.rejected[0].message).toContain('verification-error:sync throw');
  });

  it('매 호출이 독립적이다 — 거부 뒤에도 다음 정상 호출은 다운로드한다', async () => {
    let healthy = false;
    const { gate, calls } = makeGate({ fetchBuffer: async (url) => (healthy ? goodFiles[url] ?? null : null) });
    expect(await gate(infoOf(bytes))).toBe(false);
    healthy = true;
    expect(await gate(infoOf(bytes))).toBe(true);
    expect(calls.download).toBe(1);
    expect(calls.rejected).toHaveLength(1);
  });

  it('canary 채널은 canary 피드로 검증하고, latest 서명만 있으면 거부한다', async () => {
    const { gate, calls } = makeGate({ channel: 'canary' }); // goodFiles에는 latest만 있음
    expect(await gate(infoOf(bytes))).toBe(false);
    expect(calls.rejected[0].message).toBe('UPDATE_FEED_REJECTED:feed-unavailable');
    const canaryFiles = { [`${BASE}/canary.yml`]: bytes, [`${BASE}/canary.yml.sig`]: sigBytes };
    const ok = makeGate({ channel: 'canary', files: canaryFiles });
    expect(await ok.gate(infoOf(bytes))).toBe(true);
  });
});

describe('describeRejection', () => {
  it('사유를 접두사와 함께 적고, info 불일치는 다른 필드 이름을 덧붙인다', () => {
    expect(describeRejection({ ok: false, reason: 'signature-mismatch' })).toBe('UPDATE_FEED_REJECTED:signature-mismatch');
    expect(describeRejection({ ok: false, reason: 'info-mismatch', differingKeys: ['version', 'files'] })).toBe('UPDATE_FEED_REJECTED:info-mismatch(version,files)');
    expect(describeRejection({ ok: false, reason: 'info-mismatch', differingKeys: [] })).toBe('UPDATE_FEED_REJECTED:info-mismatch');
  });
});

describe('feedFileNames', () => {
  it('채널 이름으로 yml·서명 파일명을 만든다', () => {
    expect(feedFileNames('latest')).toEqual({ yml: 'latest.yml', sig: 'latest.yml.sig' });
    expect(feedFileNames('canary')).toEqual({ yml: 'canary.yml', sig: 'canary.yml.sig' });
  });
});
