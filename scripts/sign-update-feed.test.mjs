import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { generateSigningKeyPair, signFeed, signFeedFile, verifyFeedFile, optionValue, runVerify } from './sign-update-feed.mjs';

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

  describe('verifyFeedFile — 비밀 키 없이 이미 만들어진 피드를 검증', () => {
    // 서명된 피드를 만들어 둔다. 이후 검증은 공개 키만 쓴다.
    function signedFeed(channel = 'latest') {
      const keys = generateSigningKeyPair({ dir: path.join(root, 'keys'), repoRoot: repo });
      const dir = path.join(root, 'updates');
      require('fs').mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${channel}.yml`), YML);
      signFeedFile({ dir, channel, keyPath: keys.privatePath, trustedPublicKeys: [keys.publicKeyPem] });
      return { keys, dir, trustedPublicKeys: [keys.publicKeyPem] };
    }

    it('서명된 피드는 공개 키만으로 통과한다(latest·canary)', () => {
      for (const channel of ['latest', 'canary']) {
        rmSync(path.join(root, 'keys'), { recursive: true, force: true });
        rmSync(path.join(root, 'updates'), { recursive: true, force: true });
        const { dir, trustedPublicKeys } = signedFeed(channel);
        const result = verifyFeedFile({ dir, channel, trustedPublicKeys });
        expect(path.basename(result.sigPath)).toBe(`${channel}.yml.sig`);
      }
    });

    it('서명 후 yml이 한 글자라도 바뀌면 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      writeFileSync(path.join(dir, 'latest.yml'), YML.replace('7.1.4', '7.1.5'));
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys })).toThrow('서명 검증 실패(signature-mismatch)');
    });

    it('서명 파일(.sig)이 없으면 미서명 피드로 보고 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      rmSync(path.join(dir, 'latest.yml.sig'));
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys })).toThrow('서명 파일이 없습니다');
    });

    it('yml이 없으면 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      rmSync(path.join(dir, 'latest.yml'));
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys })).toThrow('검증할 파일이 없습니다');
    });

    it('공격자가 자기 키로 서명한 피드는 신뢰 키로 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      const attacker = crypto.generateKeyPairSync('ed25519', { publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
      const forged = Buffer.from(YML.replace('aGVsbG8=', 'ZmFrZQ=='));
      writeFileSync(path.join(dir, 'latest.yml'), forged);
      writeFileSync(path.join(dir, 'latest.yml.sig'), `${crypto.sign(null, forged, crypto.createPrivateKey(attacker.privateKey)).toString('base64')}\n`);
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys })).toThrow('서명 검증 실패(signature-mismatch)');
    });

    it('다른 채널 yml의 서명을 복사해 붙여도 실패한다(서명은 그 yml 바이트에만 유효)', () => {
      const { dir, trustedPublicKeys } = signedFeed('latest');
      writeFileSync(path.join(dir, 'canary.yml'), YML.replace('7.1.4', '7.1.4-canary.0'));
      writeFileSync(path.join(dir, 'canary.yml.sig'), readFileSync(path.join(dir, 'latest.yml.sig')));
      expect(() => verifyFeedFile({ dir, channel: 'canary', trustedPublicKeys })).toThrow('signature-mismatch');
    });

    it('서명 파일 형식이 깨지면 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      const sig = readFileSync(path.join(dir, 'latest.yml.sig'), 'utf8');
      writeFileSync(path.join(dir, 'latest.yml.sig'), sig.slice(0, 40));
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys })).toThrow('bad-signature-format');
    });

    it('신뢰하는 공개 키 목록이 비어 있으면 서명이 맞아도 실패한다(fail-closed)', () => {
      const { dir } = signedFeed();
      expect(() => verifyFeedFile({ dir, channel: 'latest', trustedPublicKeys: [] })).toThrow('no-public-key');
    });

    it('허용되지 않는 채널은 실패한다', () => {
      const { dir, trustedPublicKeys } = signedFeed();
      expect(() => verifyFeedFile({ dir, channel: 'beta', trustedPublicKeys })).toThrow('channel은');
      expect(() => verifyFeedFile({ dir, channel: '../latest', trustedPublicKeys })).toThrow('channel은');
    });
  });

  describe('옵션 값 처리 — 값이 비면 조용히 기본 동작으로 바뀌지 않는다', () => {
    const MISSING_VALUE_CASES = [
      ['없이 끝남', ['--public-key']],
      ['빈 문자열', ['--public-key', '']],
      ['다음이 다른 옵션', ['--public-key', '--channel', 'latest']],
    ];

    describe('optionValue', () => {
      it('옵션이 없으면 undefined, 있으면 그 값을 돌려준다', () => {
        expect(optionValue(['--dir', 'x'], '--channel')).toBeUndefined();
        expect(optionValue(['--dir', 'x', '--channel', 'latest'], '--channel')).toBe('latest');
      });

      it.each(MISSING_VALUE_CASES)('옵션은 있는데 값이 %s이면 거부한다', (_name, args) => {
        expect(() => optionValue(args, '--public-key')).toThrow('--public-key 옵션에 값이 없습니다');
      });
    });

    describe('runVerify — 내장 공개 키로 통과할 피드로 시험한다(내장 키가 등록된 운영 구성과 같은 조건)', () => {
      function feedTrustedByEmbeddedKey() {
        const keys = generateSigningKeyPair({ dir: path.join(root, 'rv-keys'), repoRoot: repo });
        const dir = path.join(root, 'updates');
        require('fs').mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'latest.yml'), YML);
        signFeedFile({ dir, channel: 'latest', keyPath: keys.privatePath, trustedPublicKeys: [keys.publicKeyPem] });
        return { dir, embedded: [keys.publicKeyPem], publicPath: keys.publicPath };
      }
      const base = (dir) => ['--verify', '--dir', dir, '--channel', 'latest'];

      it('--public-key 옵션이 없을 때만 내장 공개 키로 검증한다', () => {
        const { dir, embedded } = feedTrustedByEmbeddedKey();
        expect(runVerify(base(dir), embedded).sigPath).toContain('latest.yml.sig');
      });

      it.each(MISSING_VALUE_CASES)('--public-key 값이 %s이면 내장 키로 대체하지 않고 거부한다(내장 키로는 통과할 피드여도)', (_name, publicKeyArgs) => {
        const { dir, embedded } = feedTrustedByEmbeddedKey();
        // 같은 피드가 옵션 없이는 통과한다는 것을 먼저 확인해, 거부가 피드 문제가 아니라 옵션 처리 때문임을 보인다.
        expect(() => runVerify(base(dir), embedded)).not.toThrow();
        const args = publicKeyArgs.includes('--channel') ? ['--verify', '--dir', dir, ...publicKeyArgs] : [...base(dir), ...publicKeyArgs];
        expect(() => runVerify(args, embedded)).toThrow('옵션에 값이 없습니다');
      });

      it('--public-key를 주면 내장 키가 아니라 그 키로만 검증한다 — 내장 키로는 통과하는 피드도 다른 키면 실패한다', () => {
        const { dir, embedded } = feedTrustedByEmbeddedKey();
        const other = generateSigningKeyPair({ dir: path.join(root, 'rv-other'), repoRoot: repo });
        expect(() => runVerify([...base(dir), '--public-key', other.publicPath], embedded)).toThrow('signature-mismatch');
      });

      it('--public-key로 맞는 키를 주면 내장 키 목록이 비어 있어도 통과한다', () => {
        const { dir, publicPath } = feedTrustedByEmbeddedKey();
        expect(runVerify([...base(dir), '--public-key', publicPath], []).sigPath).toContain('latest.yml.sig');
      });

      it('--dir·--channel의 값이 없어도 거부한다(다음 옵션을 값으로 읽지 않는다)', () => {
        const { embedded } = feedTrustedByEmbeddedKey();
        expect(() => runVerify(['--verify', '--dir', '--channel', 'latest'], embedded)).toThrow('--dir 옵션에 값이 없습니다');
        expect(() => runVerify(['--verify', '--dir', root, '--channel'], embedded)).toThrow('--channel 옵션에 값이 없습니다');
      });
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

    describe('--verify', () => {
      function signedDir() {
        const keys = generateSigningKeyPair({ dir: path.join(root, 'cli-verify-keys'), repoRoot: repo });
        const dir = path.join(root, 'updates');
        require('fs').mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, 'latest.yml'), YML);
        signFeedFile({ dir, channel: 'latest', keyPath: keys.privatePath, trustedPublicKeys: [keys.publicKeyPem] });
        return { dir, publicPath: keys.publicPath };
      }
      const verify = (dir, publicPath, channel = 'latest') => run(['--verify', '--dir', dir, '--channel', channel, ...(publicPath ? ['--public-key', publicPath] : [])]);

      it('서명된 피드는 비밀 키·암호 없이 공개 키 파일만으로 종료 코드 0으로 통과한다', () => {
        const { dir, publicPath } = signedDir();
        const result = verify(dir, publicPath);
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('서명 검증 성공');
      });

      it('yml이 바뀌면 종료 코드 1과 사유를 낸다', () => {
        const { dir, publicPath } = signedDir();
        writeFileSync(path.join(dir, 'latest.yml'), YML.replace('7.1.4', '9.9.9'));
        const result = verify(dir, publicPath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('서명 검증 실패(signature-mismatch)');
      });

      it('서명 파일이 없으면 종료 코드 1이다', () => {
        const { dir, publicPath } = signedDir();
        rmSync(path.join(dir, 'latest.yml.sig'));
        const result = verify(dir, publicPath);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('서명 파일이 없습니다');
      });

      it('다른 공개 키로 검증하면 종료 코드 1이다', () => {
        const { dir } = signedDir();
        const other = generateSigningKeyPair({ dir: path.join(root, 'other-keys'), repoRoot: repo });
        expect(verify(dir, other.publicPath).status).toBe(1);
      });

      it('--public-key 없이 내장 공개 키로 검증하는 기본 동작은, 그 목록에 없는 키로 서명한 피드를 거부한다', () => {
        const { dir } = signedDir();
        const result = verify(dir, undefined);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('서명 검증 실패');
      });

      it.each([
        ['값 없이 끝남', (dir) => ['--verify', '--dir', dir, '--channel', 'latest', '--public-key']],
        ['빈 문자열', (dir) => ['--verify', '--dir', dir, '--channel', 'latest', '--public-key', '']],
        ['다음이 다른 옵션', (dir) => ['--verify', '--dir', dir, '--public-key', '--channel', 'latest']],
      ])('--public-key 값이 %s이면 종료 코드 1로 거부한다', (_name, makeArgs) => {
        const { dir } = signedDir();
        const result = run(makeArgs(dir));
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('--public-key 옵션에 값이 없습니다');
        expect(result.stdout).not.toContain('서명 검증 성공');
      });

      it('없는 공개 키 파일, 동시에 지정한 동작, 부족한 인자는 사용법과 함께 실패한다', () => {
        const { dir } = signedDir();
        expect(verify(dir, path.join(root, 'none.pem')).stderr).toContain('공개 키 파일이 없습니다');
        expect(run(['--verify', '--sign', '--dir', dir, '--channel', 'latest']).stderr).toContain('하나의 동작만');
        expect(run(['--verify', '--dir', dir]).stderr).toContain('사용법');
        expect(run(['--verify']).status).toBe(1);
      });
    });

    it('인자가 부족하면 사용법과 함께 실패한다', () => {
      expect(run([]).status).toBe(1);
      expect(run(['--sign']).status).toBe(1);
      expect(run(['--sign', '--dir', root]).stderr).toContain('사용법');
    });
  });
});
