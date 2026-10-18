#!/usr/bin/env node
/**
 * scripts/sign-update-feed.mjs — 업데이트 피드 서명 도구(HF8).
 *
 * 설치본이 자동 업데이트로 받는 <channel>.yml에 Ed25519 서명(<channel>.yml.sig)을 만든다.
 * 셸은 electron/updateSigningPublicKey.js에 내장된 공개 키로 이 서명을 확인한 뒤에만 설치본을 내려받는다
 * (electron/updateFeedVerify.js — 같은 코드를 쓴다).
 *
 * 사용법:
 *   node scripts/sign-update-feed.mjs --generate-keypair <저장소 밖 폴더>
 *   node scripts/sign-update-feed.mjs --sign --key <비밀키.pem> --dir <yml이 있는 폴더> --channel <latest|canary>
 *
 * 비밀 키는 릴리스 PC에만 둔다. --generate-keypair는 저장소 안에는 만들지 않고(실수로 커밋 방지), 기존 파일을
 * 덮어쓰지 않으며, 비밀 키 내용을 출력하지 않는다. 키를 암호로 보호하려면 환경변수 WR_UPDATE_SIGNING_PASSPHRASE를 설정한다
 * (생성·서명 때 모두 필요). 서명 직후 앱과 같은 코드로 자가 검증하므로, 셸이 신뢰하지 않는 키로 서명했다면 여기서 실패한다.
 */
import crypto from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const { verifyFeedSignature, feedFileNames } = require('../electron/updateFeedVerify.js');
const { UPDATE_SIGNING_PUBLIC_KEYS } = require('../electron/updateSigningPublicKey.js');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRIVATE_KEY_FILE = 'update-signing-private.pem';
const PUBLIC_KEY_FILE = 'update-signing-public.pem';
const CHANNELS = ['latest', 'canary'];

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function generateSigningKeyPair({ dir, passphrase, repoRoot = REPO_ROOT }) {
  const target = path.resolve(dir);
  if (isInside(target, repoRoot)) {
    throw new Error(`비밀 키를 저장소 안에 만들 수 없습니다(커밋 사고 방지): ${target}\n릴리스 PC의 저장소 밖 폴더를 지정하세요.`);
  }
  const privatePath = path.join(target, PRIVATE_KEY_FILE);
  const publicPath = path.join(target, PUBLIC_KEY_FILE);
  if (existsSync(privatePath) || existsSync(publicPath)) {
    throw new Error(`이미 키 파일이 있어 덮어쓰지 않습니다: ${target}`);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', ...(passphrase ? { cipher: 'aes-256-cbc', passphrase } : {}) },
  });
  mkdirSync(target, { recursive: true });
  writeFileSync(privatePath, privateKey, { mode: 0o600, flag: 'wx' });
  writeFileSync(publicPath, publicKey, { flag: 'wx' });
  return { privatePath, publicPath, publicKeyPem: publicKey, encrypted: Boolean(passphrase) };
}

// 서명 후 앱과 같은 검증 함수로 확인한다. trustedPublicKeys는 셸에 내장된 공개 키 목록이다.
export function signFeed({ ymlBytes, privateKeyPem, passphrase, trustedPublicKeys = UPDATE_SIGNING_PUBLIC_KEYS }) {
  let privateKey;
  try {
    privateKey = crypto.createPrivateKey({ key: privateKeyPem, ...(passphrase ? { passphrase } : {}) });
  } catch {
    throw new Error('비밀 키를 읽을 수 없습니다 — 형식이 틀렸거나, 암호로 보호된 키라면 WR_UPDATE_SIGNING_PASSPHRASE가 없거나 틀렸습니다');
  }
  const sigBase64 = crypto.sign(null, ymlBytes, privateKey).toString('base64');
  const check = verifyFeedSignature({ ymlBytes, sigBase64, publicKeys: trustedPublicKeys });
  if (!check.ok) {
    throw new Error(
      `서명이 셸에 내장된 공개 키로 검증되지 않습니다(${check.reason}). 이 서명은 어떤 셸도 신뢰하지 않습니다.\n` +
      `이 비밀 키에 대응하는 공개 키를 electron/updateSigningPublicKey.js의 UPDATE_SIGNING_PUBLIC_KEYS에 넣고 설치본을 다시 빌드했는지 확인하세요.`
    );
  }
  return sigBase64;
}

export function signFeedFile({ dir, channel, keyPath, passphrase, trustedPublicKeys }) {
  if (!CHANNELS.includes(channel)) throw new Error(`channel은 ${CHANNELS.join(' | ')} 중 하나여야 합니다: ${channel}`);
  const names = feedFileNames(channel);
  const ymlPath = path.join(dir, names.yml);
  if (!existsSync(ymlPath)) throw new Error(`서명할 파일이 없습니다: ${ymlPath}`);
  if (!existsSync(keyPath)) throw new Error(`비밀 키 파일이 없습니다: ${keyPath}`);

  const sigBase64 = signFeed({ ymlBytes: readFileSync(ymlPath), privateKeyPem: readFileSync(keyPath, 'utf8'), passphrase, trustedPublicKeys });
  const sigPath = path.join(dir, names.sig);
  writeFileSync(sigPath, `${sigBase64}\n`, 'utf8');
  return { ymlPath, sigPath };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
  const passphrase = process.env.WR_UPDATE_SIGNING_PASSPHRASE || undefined;

  try {
    if (args.includes('--generate-keypair')) {
      const dir = get('--generate-keypair');
      if (!dir) throw new Error('사용법: --generate-keypair <저장소 밖 폴더>');
      const result = generateSigningKeyPair({ dir, passphrase });
      console.log(`비밀 키(공개하지 말 것, 저장소에 넣지 말 것): ${result.privatePath}${result.encrypted ? ' (암호 보호됨)' : ' (암호 없음 — 릴리스 PC 접근 통제에 의존)'}`);
      console.log(`공개 키 파일: ${result.publicPath}`);
      console.log('\n아래 공개 키를 electron/updateSigningPublicKey.js의 UPDATE_SIGNING_PUBLIC_KEYS 배열에 추가하세요(공개 키는 비밀이 아닙니다):\n');
      console.log(result.publicKeyPem);
      return;
    }
    if (args.includes('--sign')) {
      const dir = get('--dir');
      const channel = get('--channel');
      const keyPath = get('--key');
      if (!dir || !channel || !keyPath) throw new Error('사용법: --sign --key <비밀키.pem> --dir <폴더> --channel <latest|canary>');
      const result = signFeedFile({ dir, channel, keyPath, passphrase });
      console.log(`서명 완료: ${result.sigPath}`);
      return;
    }
    throw new Error('사용법: --generate-keypair <폴더> | --sign --key <pem> --dir <폴더> --channel <latest|canary>');
  } catch (err) {
    console.error(`[sign-update-feed] FAILED: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
