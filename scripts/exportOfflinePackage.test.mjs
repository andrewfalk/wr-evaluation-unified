import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// scripts/export-offline-package.ps1은 PowerShell + Docker라 단위 테스트가 어렵다. 그래서 업데이트 피드 서명(HF8)의 **불변식**을
// 소스 수준에서 고정한다 — 서명이 사전 검증보다 먼저인지, 실패가 패키지 삭제보다 먼저인지, 두 폴더에 .sig가 쌍으로 들어가는지 등.
// 실제 동작은 e2e(시험 버전·시험 키로 패키징 전체 실행)로 확인했다. 이 테스트는 그 순서·조건이 의도 없이 바뀌는 것을 막는다.
const SCRIPT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'export-offline-package.ps1'), 'utf8');

const indexOfOrFail = (needle, from = 0) => {
  const i = SCRIPT.indexOf(needle, from);
  if (i < 0) throw new Error(`export-offline-package.ps1에서 찾지 못했습니다: ${needle}`);
  return i;
};

describe('export-offline-package.ps1 — 업데이트 피드 서명(HF8)', () => {
  it('서명 키와 서명 생략 스위치를 받는다', () => {
    const params = SCRIPT.match(/param\(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(params).toMatch(/\[string\]\$UpdateSigningKey/);
    expect(params).toMatch(/\[switch\]\$AllowUnsignedUpdateFeed/);
  });

  it('기본은 서명 필수다 — 서명 생략은 -AllowUnsignedUpdateFeed로 명시할 때뿐이다', () => {
    expect(SCRIPT).toMatch(/\$SignUpdateFeed\s*=\s*-not\s+\$AllowUnsignedUpdateFeed/);
  });

  it('-AllowUnsignedUpdateFeed와 -UpdateSigningKey를 함께 주면 거부한다', () => {
    expect(SCRIPT).toMatch(/if\s*\(\$AllowUnsignedUpdateFeed\s+-and\s+\$UpdateSigningKey\)[\s\S]*?exit 1/);
  });

  it('서명이 필요하면 사전 검증(verify-update-artifacts)에 --require-signature를 넘긴다', () => {
    const fn = SCRIPT.match(/function Test-UpdateArtifacts \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn).toMatch(/if\s*\(\$SignUpdateFeed\)\s*\{\s*\$verifyArgs\s*\+=\s*'--require-signature'\s*\}/);
    expect(fn).toContain('verify-update-artifacts.mjs');
  });

  it('서명은 사전 검증보다 먼저 한다 — 이전 빌드의 낡은 .sig를 새로 덮어쓰고, 실패하면 아무것도 만들기 전에 중단한다', () => {
    const preflight = indexOfOrFail('Write-Step "Update artifact pre-flight');
    const signing = indexOfOrFail('Invoke-UpdateFeedSigning', preflight);
    const check = indexOfOrFail('$preflight = Test-UpdateArtifacts', preflight);
    expect(signing).toBeLessThan(check);
  });

  it('서명 키 누락·키 파일 없음 검사는 패키지 폴더를 지우는 단계보다 앞선다(실패해도 기존 패키지가 보존된다)', () => {
    // 에러 문구가 아니라 "조건"을 찾는다 — 조건을 죽여도 문구는 남기 때문이다.
    const keyRequired = indexOfOrFail('if (-not $UpdateSigningKey) {');
    const keyMissing = indexOfOrFail('if (-not (Test-Path -LiteralPath $UpdateSigningKey -PathType Leaf)) {');
    const removePackage = indexOfOrFail('Remove-Item -Recurse -Force $PackageDir');
    expect(keyRequired).toBeLessThan(removePackage);
    expect(keyMissing).toBeLessThan(removePackage);
    // 각 조건 바로 뒤에 오류와 중단(exit 1)이 따른다.
    expect(SCRIPT.slice(keyRequired, keyRequired + 400)).toMatch(/Write-Error[\s\S]*?exit 1/);
    expect(SCRIPT.slice(keyMissing, keyMissing + 200)).toMatch(/Write-Error[\s\S]*?exit 1/);
  });

  it('서명 도구는 --sign으로, 비밀 키 암호는 스크립트가 받거나 출력하지 않는다(환경변수는 도구가 직접 읽음)', () => {
    expect(SCRIPT).toMatch(/sign-update-feed\.mjs"\)\s+--sign\s+--key\s+\$UpdateSigningKey\s+--dir\s+\$artifactDir\s+--channel\s+\$UpdateChannel/);
    expect(SCRIPT).not.toMatch(/\[string\]\$\w*[Pp]assphrase/); // 암호를 인자로 받지 않는다
    expect(SCRIPT).not.toMatch(/Write-(Host|Ok|Warn|Error)[^\n]*\$env:WR_UPDATE_SIGNING_PASSPHRASE/); // 출력하지 않는다
  });

  it('.sig는 electron/과 updates/ 두 곳에 yml과 쌍으로 복사하고, 복사할 때마다 복사본을 다시 검증한다', () => {
    expect(SCRIPT).toMatch(/Copy-Required \$signaturePath \$electronDest\s+Test-UpdateFeedSignature \$electronDest/);
    expect(SCRIPT).toMatch(/Copy-Required \$signaturePath \$updatesDest\s+Test-UpdateFeedSignature \$updatesDest/);
  });

  it('.sig 복사는 서명 모드에서만 한다 — 서명 없는 패키지에 산출물 폴더의 .sig가 섞여 들어가지 않는다', () => {
    for (const dest of ['$electronDest', '$updatesDest']) {
      const at = indexOfOrFail(`Copy-Required $signaturePath ${dest}`);
      const guardAt = SCRIPT.lastIndexOf('if ($SignUpdateFeed) {', at);
      expect(guardAt).toBeGreaterThan(-1); // 복사 앞에 서명 모드 가드가 있고
      // 가드부터 복사 줄까지 "닫는 중괄호만 있는 줄"이 없다 = 아직 같은 if 블록 안이다.
      expect(SCRIPT.slice(guardAt, at)).not.toMatch(/^\s*\}\s*$/m);
    }
  });

  it('사전 검증이 서명을 확인하지 못했으면(signatureVerified 없음) 중단한다', () => {
    expect(SCRIPT).toMatch(/if\s*\(-not\s+\$verified\.signatureVerified\)\s*\{[^}]*exit 1/);
  });

  it('release-manifest.json에 서명 여부와 서명 파일명을 기록한다(미서명·서버 전용 export는 false)', () => {
    expect(SCRIPT).toMatch(/updateFeedSigned\s*=\s*\[bool\]\$SignUpdateFeed/);
    expect(SCRIPT).toMatch(/signatureFile\s*=\s*if \(\$SignUpdateFeed\) \{ "\$UpdateMetadataFileName\.sig" \} else \{ \$null \}/);
    expect(SCRIPT).toMatch(/updateFeedSigned\s*=\s*\$false/); // -AllowMissingElectronInstaller 분기
    expect(SCRIPT).toMatch(/updateFeedSigned\s*=\s*\$UpdateArtifactManifest\.updateFeedSigned/);
  });

  it('서명 키가 저장소 안이거나 클라우드 동기화 폴더에 있으면 경고한다', () => {
    expect(SCRIPT).toMatch(/StartsWith\(\[System\.IO\.Path\]::GetFullPath\(\$RepoRoot\)/);
    expect(SCRIPT).toMatch(/OneDrive\|Dropbox/);
  });
});
