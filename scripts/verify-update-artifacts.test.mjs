import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { verifyUpdateArtifacts, pickExeEntry, resolveSafeInstallerName, installerNameHasVersion } from './verify-update-artifacts.mjs';

const VERIFIER_PATH = fileURLToPath(new URL('./verify-update-artifacts.mjs', import.meta.url));

function sha512Base64(buf) {
  return createHash('sha512').update(buf).digest('base64');
}

function writeArtifacts(dir, { installerName, installerContent, metadataFileName, extraFilesEntries = [], skipBlockmap = false, overrideSha512, version = '6.5.0' }) {
  const installerBuf = Buffer.from(installerContent);
  writeFileSync(path.join(dir, installerName), installerBuf);
  if (!skipBlockmap) writeFileSync(path.join(dir, `${installerName}.blockmap`), Buffer.from('blockmap'));

  const metadata = {
    ...(version === null ? {} : { version }),
    files: [
      ...extraFilesEntries,
      { url: encodeURIComponent(installerName), sha512: overrideSha512 ?? sha512Base64(installerBuf), size: installerBuf.length },
    ],
    path: encodeURIComponent(installerName),
    sha512: overrideSha512 ?? sha512Base64(installerBuf),
    releaseDate: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, metadataFileName), yaml.dump(metadata), 'utf-8');
  return metadata;
}

describe('verify-update-artifacts', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wr-update-artifacts-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('정상 조합 통과', () => {
    writeArtifacts(dir, { installerName: 'Setup-6.5.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml' });
    const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' });
    expect(result).toEqual({
      channel: 'latest',
      version: '6.5.0',
      metadataFile: 'latest.yml',
      installerFile: 'Setup-6.5.0.exe',
      blockmapFile: 'Setup-6.5.0.exe.blockmap',
      sha512Verified: true,
    });
  });

  it('sha512 불일치 → 실패', () => {
    writeArtifacts(dir, {
      installerName: 'Setup-6.5.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml',
      overrideSha512: sha512Base64(Buffer.from('different-bytes')),
    });
    expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' }))
      .toThrow(/SHA-512 mismatch/);
  });

  it('.exe가 files[]의 첫 항목이 아니어도 올바르게 선택', () => {
    writeArtifacts(dir, {
      installerName: 'Setup-6.5.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml',
      extraFilesEntries: [{ url: 'Setup-6.5.0.exe.blockmap', sha512: 'irrelevant', size: 1 }],
    });
    const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' });
    expect(result.installerFile).toBe('Setup-6.5.0.exe');
  });

  it('url에 경로 이탈(../)이 들어간 경우 거부', () => {
    const installerBuf = Buffer.from('installer-bytes');
    writeFileSync(path.join(dir, 'Setup-6.5.0.exe'), installerBuf);
    const metadata = {
      version: '6.5.0',
      files: [{ url: encodeURIComponent('../../evil.exe'), sha512: sha512Base64(installerBuf), size: installerBuf.length }],
    };
    writeFileSync(path.join(dir, 'latest.yml'), yaml.dump(metadata), 'utf-8');
    expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' }))
      .toThrow(/outside the artifact directory/);
  });

  it('.blockmap 없음 → 실패', () => {
    writeArtifacts(dir, { installerName: 'Setup-6.5.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', skipBlockmap: true });
    expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' }))
      .toThrow(/blockmap not found/);
  });

  it('한글+공백 파일명(URL 인코딩된 url) 정상 처리', () => {
    const installerName = '직업성 질환 통합 평가 프로그램 Setup 6.5.0.exe';
    writeArtifacts(dir, { installerName, installerContent: 'installer-bytes', metadataFileName: 'canary.yml' });
    const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'canary.yml' });
    expect(result.installerFile).toBe(installerName);
    expect(result.channel).toBe('canary');
  });

  it('한글+공백 파일명 — 실제 electron-builder처럼 url이 인코딩 안 된 원문 그대로인 경우도 처리', () => {
    // 실측 확인: electron-builder 24.13.3이 실제로 생성하는 latest.yml의 `url` 필드는
    // encodeURIComponent를 거치지 않은 원문 파일명이다. decodeURIComponent는 '%' 시퀀스가
    // 없는 문자열에는 항등적으로 안전하므로 이 형식도 그대로 통과해야 한다.
    const installerName = '직업성 질환 통합 평가 프로그램 Setup 6.4.0.exe';
    const installerBuf = Buffer.from('installer-bytes');
    writeFileSync(path.join(dir, installerName), installerBuf);
    writeFileSync(path.join(dir, `${installerName}.blockmap`), Buffer.from('blockmap'));
    const metadata = {
      version: '6.4.0',
      files: [{ url: installerName, sha512: sha512Base64(installerBuf), size: installerBuf.length }], // NOT encodeURIComponent'd
      path: installerName,
      sha512: sha512Base64(installerBuf),
    };
    writeFileSync(path.join(dir, 'latest.yml'), yaml.dump(metadata), 'utf-8');
    const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' });
    expect(result.installerFile).toBe(installerName);
  });

  // 릴리즈 버전 일치(expectedVersion) — export-offline-package.ps1이 package.json 버전을 넘겨
  // "오래된 설치본 + 오래된 latest.yml" 조합이 새 버전 패키지에 포장되는 것을 막는다.
  describe('expectedVersion', () => {
    it('전달 + 일치 → 통과', () => {
      writeArtifacts(dir, { installerName: 'Setup 7.0.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '7.0.0' });
      const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml', expectedVersion: '7.0.0' });
      expect(result.version).toBe('7.0.0');
      expect(result.installerFile).toBe('Setup 7.0.0.exe');
    });

    it('전달 + 메타데이터 버전 불일치(이전 빌드 잔여물) → 실패, 메시지에 기대·실제 버전 포함', () => {
      writeArtifacts(dir, { installerName: 'Setup 6.5.4.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '6.5.4' });
      expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml', expectedVersion: '7.0.0' }))
        .toThrow(/version mismatch.*latest\.yml says 6\.5\.4.*release version is 7\.0\.0/s);
    });

    it('전달 + 메타데이터에 version 필드 없음 → 실패', () => {
      writeArtifacts(dir, { installerName: 'Setup 7.0.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: null });
      expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml', expectedVersion: '7.0.0' }))
        .toThrow(/no version field/);
    });

    it('전달 + 메타데이터 버전은 맞지만 설치본 파일명 버전이 다름 → 실패', () => {
      writeArtifacts(dir, { installerName: 'Setup 6.5.4.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '7.0.0' });
      expect(() => verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml', expectedVersion: '7.0.0' }))
        .toThrow(/installer file name does not carry release version 7\.0\.0/);
    });

    it('미전달 + version 필드 없음 → 기존 동작 유지(version: null로 통과)', () => {
      writeArtifacts(dir, { installerName: 'Setup 7.0.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: null });
      const result = verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' });
      expect(result.version).toBeNull();
    });

    it('미전달 + 버전이 달라도 통과(하위호환 — 비교는 expectedVersion을 줄 때만)', () => {
      writeArtifacts(dir, { installerName: 'Setup 6.5.4.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '6.5.4' });
      expect(verifyUpdateArtifacts({ artifactDir: dir, metadataFileName: 'latest.yml' }).version).toBe('6.5.4');
    });

    // PowerShell은 이 CLI를 호출하고 종료코드로 중단하므로, 인자 배선(--expected-version)과
    // 종료코드·stderr 계약을 CLI 경로로 직접 검증한다.
    it('CLI: --expected-version 불일치 → 종료코드 1 + stderr에 version mismatch', () => {
      writeArtifacts(dir, { installerName: 'Setup 6.5.4.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '6.5.4' });
      const r = spawnSync(process.execPath, [VERIFIER_PATH, '--artifact-dir', dir, '--metadata-file', 'latest.yml', '--expected-version', '7.0.0'], { encoding: 'utf-8' });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/version mismatch/);
      expect(r.stdout).toBe('');
    });

    it('CLI: --expected-version 일치 → 종료코드 0 + stdout JSON', () => {
      writeArtifacts(dir, { installerName: 'Setup 7.0.0.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '7.0.0' });
      const r = spawnSync(process.execPath, [VERIFIER_PATH, '--artifact-dir', dir, '--metadata-file', 'latest.yml', '--expected-version', '7.0.0'], { encoding: 'utf-8' });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ version: '7.0.0', sha512Verified: true });
    });

    it('CLI: --expected-version 없이 호출하면 기존 동작(버전 비교 없음)', () => {
      writeArtifacts(dir, { installerName: 'Setup 6.5.4.exe', installerContent: 'installer-bytes', metadataFileName: 'latest.yml', version: '6.5.4' });
      const r = spawnSync(process.execPath, [VERIFIER_PATH, '--artifact-dir', dir, '--metadata-file', 'latest.yml'], { encoding: 'utf-8' });
      expect(r.status).toBe(0);
    });
  });

  describe('installerNameHasVersion', () => {
    it('버전으로 끝나는 NSIS 파일명 허용', () => {
      expect(installerNameHasVersion('직업성 질환 통합 평가 프로그램 Setup 7.0.0.exe', '7.0.0')).toBe(true);
      expect(installerNameHasVersion('Setup-7.0.0.exe', '7.0.0')).toBe(true);
    });
    it('다른 버전·접두 숫자가 붙은 버전은 거부', () => {
      expect(installerNameHasVersion('Setup 6.5.4.exe', '7.0.0')).toBe(false);
      expect(installerNameHasVersion('Setup 17.0.0.exe', '7.0.0')).toBe(false);
      expect(installerNameHasVersion('Setup 7.0.0-beta.exe', '7.0.0')).toBe(false);
    });
  });

  describe('pickExeEntry', () => {
    it('files가 배열이 아니면 에러', () => {
      expect(() => pickExeEntry(undefined)).toThrow(/files\[\] is missing/);
    });
    it('.exe 항목이 없으면 에러', () => {
      expect(() => pickExeEntry([{ url: 'foo.blockmap' }])).toThrow(/no \.exe entry/);
    });
  });

  describe('resolveSafeInstallerName', () => {
    it('바른 URL 인코딩 파일명은 그대로 디코드', () => {
      expect(resolveSafeInstallerName(encodeURIComponent('Setup 6.5.0.exe'))).toBe('Setup 6.5.0.exe');
    });
    it('디코딩 후 경로 구분자가 있으면 거부', () => {
      expect(() => resolveSafeInstallerName(encodeURIComponent('sub/dir/evil.exe'))).toThrow(/outside the artifact directory/);
    });
  });
});
