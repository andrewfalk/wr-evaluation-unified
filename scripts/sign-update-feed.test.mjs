import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { generateSigningKeyPair, signFeed, signFeedFile } from './sign-update-feed.mjs';

const require = createRequire(import.meta.url);
const { verifyFeedSignature } = require('../electron/updateFeedVerify.js');

const SIGNER_PATH = fileURLToPath(new URL('./sign-update-feed.mjs', import.meta.url));
const YML = 'version: 7.1.4\nfiles:\n  - url: Setup-7.1.4.exe\n    sha512: aGVsbG8=\n    size: 10\npath: Setup-7.1.4.exe\nsha512: aGVsbG8=\n';

describe('sign-update-feed', () => {
  let root; // 가짜 "저장소 밖" 작업 폴더
  let repo; // 가짜 저장소 루트
  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'wr-sign-feed-'));
    repo = path.join(root, 'repo');
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  describe('generateSigningKeyPair', () => {
    it('저장소 밖 폴더에 비밀 키와 공개 키를 만들고 반환값에 비밀 키 내용을 싣지 않는다', () => {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), repoRoot: repo });
      expect(existsSync(keys.privatePath)).toBe(true);
      expect(existsSync(keys.publicPath)).toBe(true);
      expect(readFileSync(keys.privatePath, 'utf8')).toContain('BEGIN PRIVATE KEY');
      expect(keys.publicKeyPem).toContain('BEGIN PUBLIC KEY');
      expect(JSON.stringify(keys)).not.toContain('PRIVATE KEY');
      expect(keys.encrypted).toBe(false);
    });

    it('저장소 안(하위 폴더 포함)에는 만들지 않는다 — 커밋 사고 방지', () => {
      expect(() => generateSigningKeyPair({ dir: repo, repoRoot: repo })).toThrow('저장소 안');
      expect(() => generateSigningKeyPair({ dir: path.join(repo, 'keys', 'sub'), repoRoot: repo })).toThrow('저장소 안');
      expect(existsSync(path.join(repo, 'keys'))).toBe(false);
    });

    it('이름만 비슷한 형제 폴더(repo-keys)는 저장소 밖으로 본다', () => {
      expect(() => generateSigningKeyPair({ dir: path.join(root, 'repo-keys'), repoRoot: repo })).not.toThrow();
    });

    it('기존 키 파일을 덮어쓰지 않는다', () => {
      const dir = path.join(root, 'keys');
      const first = generateSigningKeyPair({ dir, repoRoot: repo });
      const before = readFileSync(first.privatePath, 'utf8');
      expect(() => generateSigningKeyPair({ dir, repoRoot: repo })).toThrow('덮어쓰지 않습니다');
      expect(readFileSync(first.privatePath, 'utf8')).toBe(before);
    });

    it('암호를 주면 비밀 키가 암호화돼 저장된다', () => {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), passphrase: 'pw-123', repoRoot: repo });
      expect(keys.encrypted).toBe(true);
      expect(readFileSync(keys.privatePath, 'utf8')).toContain('ENCRYPTED PRIVATE KEY');
    });
  });

  describe('signFeed', () => {
    const bytes = Buffer.from(YML);

    it('서명은 셸이 쓰는 검증 함수로 통과한다', () => {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), repoRoot: repo });
      const sig = signFeed({ ymlBytes: bytes, privateKeyPem: readFileSync(keys.privatePath, 'utf8'), trustedPublicKeys: [keys.publicKeyPem] });
      expect(verifyFeedSignature({ ymlBytes: bytes, sigBase64: sig, publicKeys: [keys.publicKeyPem] })).toEqual({ ok: true });
    });

    it('셸에 내장되지 않은 키로 서명하면 실패한다 — 어떤 셸도 신뢰하지 않는 서명을 만들지 않는다', () => {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), repoRoot: repo });
      const other = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      expect(() => signFeed({ ymlBytes: bytes, privateKeyPem: readFileSync(keys.privatePath, 'utf8'), trustedPublicKeys: [other.publicKey] }))
        .toThrow('내장된 공개 키로 검증되지 않습니다');
      expect(() => signFeed({ ymlBytes: bytes, privateKeyPem: readFileSync(keys.privatePath, 'utf8'), trustedPublicKeys: [] }))
        .toThrow('no-public-key');
    });

    it('암호로 보호된 키는 맞는 암호로만 서명한다', () => {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), passphrase: 'pw-123', repoRoot: repo });
      const pem = readFileSync(keys.privatePath, 'utf8');
      const trustedPublicKeys = [keys.publicKeyPem];
      expect(() => signFeed({ ymlBytes: bytes, privateKeyPem: pem, trustedPublicKeys })).toThrow('비밀 키를 읽을 수 없습니다');
      expect(() => signFeed({ ymlBytes: bytes, privateKeyPem: pem, passphrase: 'wrong', trustedPublicKeys })).toThrow('비밀 키를 읽을 수 없습니다');
      expect(signFeed({ ymlBytes: bytes, privateKeyPem: pem, passphrase: 'pw-123', trustedPublicKeys })).toMatch(/^[A-Za-z0-9+/]+=*$/);
    });

    it('비밀 키가 아닌 내용이면 실패한다', () => {
      expect(() => signFeed({ ymlBytes: bytes, privateKeyPem: 'garbage', trustedPublicKeys: ['x'] })).toThrow('비밀 키를 읽을 수 없습니다');
    });
  });

  describe('signFeedFile', () => {
    function setup() {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), repoRoot: repo });
      const dir = path.join(root, 'release');
      require('fs').mkdirSync(dir, { recursive: true });
      return { keys, dir, trustedPublicKeys: [keys.publicKeyPem] };
    }

    it('<channel>.yml.sig를 개행 한 줄로 만들고 그 서명이 yml과 맞는다', () => {
      const { keys, dir, trustedPublicKeys } = setup();
      writeFileSync(path.join(dir, 'latest.yml'), YML);
      const result = signFeedFile({ dir, channel: 'latest', keyPath: keys.privatePath, trustedPublicKeys });
      const sigText = readFileSync(result.sigPath, 'utf8');
      expect(path.basename(result.sigPath)).toBe('latest.yml.sig');
      expect(sigText.endsWith('\n')).toBe(true);
      expect(sigText.trim().split('\n')).toHaveLength(1);
      expect(verifyFeedSignature({ ymlBytes: readFileSync(result.ymlPath), sigBase64: sigText, publicKeys: trustedPublicKeys }).ok).toBe(true);
    });

    it('canary 채널도 서명한다', () => {
      const { keys, dir, trustedPublicKeys } = setup();
      writeFileSync(path.join(dir, 'canary.yml'), YML);
      expect(path.basename(signFeedFile({ dir, channel: 'canary', keyPath: keys.privatePath, trustedPublicKeys }).sigPath)).toBe('canary.yml.sig');
    });

    it('서명한 뒤 yml을 고치면 그 서명은 더 이상 맞지 않는다', () => {
      const { keys, dir, trustedPublicKeys } = setup();
      writeFileSync(path.join(dir, 'latest.yml'), YML);
      const { sigPath } = signFeedFile({ dir, channel: 'latest', keyPath: keys.privatePath, trustedPublicKeys });
      const edited = Buffer.from(YML.replace('7.1.4', '9.9.9'));
      expect(verifyFeedSignature({ ymlBytes: edited, sigBase64: readFileSync(sigPath, 'utf8'), publicKeys: trustedPublicKeys }).ok).toBe(false);
    });

    it('yml이 없으면 서명 파일을 만들지 않고 실패한다', () => {
      const { keys, dir, trustedPublicKeys } = setup();
      expect(() => signFeedFile({ dir, channel: 'latest', keyPath: keys.privatePath, trustedPublicKeys })).toThrow('서명할 파일이 없습니다');
      expect(existsSync(path.join(dir, 'latest.yml.sig'))).toBe(false);
    });

    it('허용되지 않는 채널·없는 키 파일은 실패한다', () => {
      const { keys, dir, trustedPublicKeys } = setup();
      writeFileSync(path.join(dir, 'latest.yml'), YML);
      expect(() => signFeedFile({ dir, channel: 'beta', keyPath: keys.privatePath, trustedPublicKeys })).toThrow('channel은');
      expect(() => signFeedFile({ dir, channel: '../latest', keyPath: keys.privatePath, trustedPublicKeys })).toThrow('channel은');
      expect(() => signFeedFile({ dir, channel: 'latest', keyPath: path.join(root, 'none.pem'), trustedPublicKeys })).toThrow('비밀 키 파일이 없습니다');
    });
  });

  describe('CLI', () => {
    const run = (args, env = {}) => spawnSync(process.execPath, [SIGNER_PATH, ...args], { encoding: 'utf8', env: { ...process.env, WR_UPDATE_SIGNING_PASSPHRASE: '', ...env } });

    it('--generate-keypair는 공개 키만 출력하고 비밀 키 내용은 출력하지 않으며, 같은 폴더에 다시 실행하면 실패한다', () => {
      const dir = path.join(root, 'cli-keys');
      const first = run(['--generate-keypair', dir]);
      expect(first.status).toBe(0);
      expect(first.stdout).toContain('BEGIN PUBLIC KEY');
      expect(first.stdout).not.toContain('PRIVATE KEY-----');
      expect(existsSync(path.join(dir, 'update-signing-private.pem'))).toBe(true);

      const second = run(['--generate-keypair', dir]);
      expect(second.status).toBe(1);
      expect(second.stderr).toContain('덮어쓰지 않습니다');
    });

    it('--generate-keypair는 저장소 안 폴더를 거부한다', () => {
      const inside = path.join(path.dirname(SIGNER_PATH), '..', 'tmp-should-not-exist-keys');
      const result = run(['--generate-keypair', inside]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('저장소 안');
      expect(existsSync(inside)).toBe(false);
    });

    it('내장 공개 키가 없는 상태에서는 어떤 키로도 서명이 거부된다(fail-closed)', () => {
      const dir = path.join(root, 'cli-keys');
      expect(run(['--generate-keypair', dir]).status).toBe(0);
      const release = path.join(root, 'release');
      require('fs').mkdirSync(release, { recursive: true });
      writeFileSync(path.join(release, 'latest.yml'), YML);
      const result = run(['--sign', '--key', path.join(dir, 'update-signing-private.pem'), '--dir', release, '--channel', 'latest']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('updateSigningPublicKey');
      expect(existsSync(path.join(release, 'latest.yml.sig'))).toBe(false);
    });

    it('인자가 부족하면 사용법과 함께 실패한다', () => {
      expect(run([]).status).toBe(1);
      expect(run(['--sign']).status).toBe(1);
      expect(run(['--sign', '--dir', root]).stderr).toContain('사용법');
    });
  });
});
