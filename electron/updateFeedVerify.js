'use strict';

// 업데이트 피드(<channel>.yml) 서명 검증 — HF8. 순수 모듈(Electron·네트워크에 직접 의존하지 않음)이라
// 셸(main.js)·서명 도구(scripts/sign-update-feed.mjs)·패키징 사전 검증이 같은 코드를 쓴다.
//
// 서명 형식: <channel>.yml의 바이트 전체에 대한 Ed25519 서명(64바이트)을 base64 한 줄로 적은 <channel>.yml.sig.
// 왜 필요한가: electron-updater의 sha512 검사는 yml이 적어 둔 해시와 설치본을 맞춰 볼 뿐이라, updates 폴더에 쓸 수 있는
// 쪽이 설치본과 yml을 함께 바꿔치기하면 통과한다. 개인 키 없이는 유효한 .sig를 만들 수 없게 해 그 경로를 닫는다.
//
// 검증 순서가 중요하다: ① 서명 확인 ② 그 다음에야 YAML 파싱(서명되지 않은 입력을 파서에 넣지 않는다 — js-yaml
// CPU 소모 권고) ③ electron-updater가 자기 요청으로 받아 파싱한 info와 같은지 비교. ③이 필요한 이유: 다운로드는
// 그 info를 따라 하는데, info는 우리가 서명을 확인한 바이트와 별개의 요청 결과이기 때문이다.
const crypto = require('crypto');
const { isDeepStrictEqual } = require('util');
const yaml = require('js-yaml');

const SIGNATURE_BYTES = 64; // Ed25519
const FEED_MAX_BYTES = 256 * 1024;
const SIG_MAX_BYTES = 1024;

function feedFileNames(channel) {
  return { yml: `${channel}.yml`, sig: `${channel}.yml.sig` };
}

// 서명 확인만. 키가 하나도 없으면 열어 두지 않고 거부한다(fail-closed). 목록 안의 어느 키로든 맞으면 통과 —
// 키를 바꿀 때 새 키를 먼저 목록에 넣은 셸을 배포하고 나중에 옛 키를 빼기 위한 것이다.
function verifyFeedSignature({ ymlBytes, sigBase64, publicKeys }) {
  if (!Array.isArray(publicKeys) || publicKeys.length === 0) return { ok: false, reason: 'no-public-key' };
  if (!Buffer.isBuffer(ymlBytes)) return { ok: false, reason: 'invalid-input' };

  const text = String(sigBase64 ?? '').trim();
  const signature = Buffer.from(text, 'base64');
  // Buffer.from은 base64가 아닌 글자를 조용히 무시하므로, 정규 형태로 다시 만들어 같은지 확인한다.
  if (signature.length !== SIGNATURE_BYTES || signature.toString('base64') !== text) {
    return { ok: false, reason: 'bad-signature-format' };
  }

  for (const pem of publicKeys) {
    try {
      if (crypto.verify(null, ymlBytes, crypto.createPublicKey(pem), signature)) return { ok: true };
    } catch {
      // 목록 안의 잘못된 키 하나가 나머지 키의 검증을 막지 않게 한다.
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

// 서명 확인 → YAML 파싱 → electron-updater의 info와 비교. info는 electron-updater가 yml을 js-yaml로 파싱한 결과
// 객체 그대로이므로(AppUpdater→GenericProvider→parseUpdateInfo), 같은 바이트라면 깊은 비교로 정확히 같다.
// 필드를 골라 비교하지 않고 통째로 비교해 빠뜨리는 필드가 없게 한다.
function verifyFeedForUpdate({ ymlBytes, sigBase64, publicKeys, info }) {
  const signature = verifyFeedSignature({ ymlBytes, sigBase64, publicKeys });
  if (!signature.ok) return signature;

  let feed;
  try {
    feed = yaml.load(ymlBytes.toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid-yaml' };
  }
  if (!isDeepStrictEqual(feed, info)) {
    const keys = new Set([...Object.keys(feed ?? {}), ...Object.keys(info ?? {})]);
    const differingKeys = [...keys].filter((key) => !isDeepStrictEqual(feed?.[key], info?.[key]));
    return { ok: false, reason: 'info-mismatch', differingKeys };
  }
  return { ok: true };
}

// update-available 직후, 다운로드 전에 호출한다. fetchBuffer(url)는 Buffer를 돌려주고 실패·404면 null이다
// (네트워크는 호출 쪽 책임). 서명 파일이 없으면(미서명 피드) 거부한다.
async function checkFeedBeforeDownload({ feedBaseUrl, channel, info, publicKeys, fetchBuffer }) {
  const names = feedFileNames(channel);
  const base = feedBaseUrl.replace(/\/+$/, '');
  const [ymlBytes, sigBytes] = await Promise.all([
    fetchBuffer(`${base}/${names.yml}`, FEED_MAX_BYTES),
    fetchBuffer(`${base}/${names.sig}`, SIG_MAX_BYTES),
  ]);
  if (!ymlBytes) return { ok: false, reason: 'feed-unavailable' };
  if (!sigBytes) return { ok: false, reason: 'signature-file-missing' };
  return verifyFeedForUpdate({ ymlBytes, sigBase64: sigBytes.toString('utf8'), publicKeys, info });
}

// 거부 사유를 로그·메뉴에 남길 오류 메시지로 만든다. info-mismatch는 어떤 필드가 달랐는지 함께 적는다.
function describeRejection(verdict) {
  const detail = verdict.differingKeys?.length ? `(${verdict.differingKeys.join(',')})` : '';
  return `UPDATE_FEED_REJECTED:${verdict.reason}${detail}`;
}

// update-available → 다운로드 허용 판정을 한 함수로 묶는다. autoUpdater.autoDownload=false이므로 이 게이트가
// download()를 부르는 유일한 경로여야 한다(main.js 연결부는 테스트되지 않으므로 이 로직을 여기에 둔다).
// 거부뿐 아니라 검증 중 예외도 다운로드로 이어지지 않는다 — 어떤 실패든 onRejected로만 알린다. 허용 시 true를 돌려준다.
function createDownloadGate({ feedBaseUrl, channel, publicKeys, fetchBuffer, download, onRejected }) {
  return async function downloadGate(info) {
    let verdict;
    try {
      verdict = await checkFeedBeforeDownload({ feedBaseUrl, channel, info, publicKeys, fetchBuffer });
    } catch (err) {
      verdict = { ok: false, reason: `verification-error:${err?.message ?? err}` };
    }
    if (!verdict.ok) {
      onRejected(new Error(describeRejection(verdict)));
      return false;
    }
    download();
    return true;
  };
}

module.exports = {
  SIGNATURE_BYTES, FEED_MAX_BYTES, SIG_MAX_BYTES,
  feedFileNames, verifyFeedSignature, verifyFeedForUpdate, checkFeedBeforeDownload, describeRejection, createDownloadGate,
};
