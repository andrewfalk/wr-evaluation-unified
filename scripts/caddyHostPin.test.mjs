import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 릴리스 B(호스트 Caddy) PR-2 — caddy.exe 버전·해시 고정, scripts/fetch-caddy.ps1, 패키징.
// PowerShell 스크립트는 CI에서 실행하지 않는다. 실제 동작은 이 PC에서 Windows PowerShell 5.1과 PowerShell 7로 확인했다
// (공식 zip 다운로드·checksums.txt 교차 대조 통과, 변조 zip·없는 zip은 종료 코드 1이고 출력 폴더 불변, 핀 파일 오류 7종 거부,
// 시험 버전으로 패키지 전체 export). 이 테스트는 그때 확인한 순서·조건과 고정 값의 형식이 의도 없이 바뀌는 것을 막는다.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const PIN_VERSION = read('../caddy/CADDY_VERSION');
const PIN_SHA = read('../caddy/caddy-windows-amd64.sha512');
const HELPER = read('caddy-pin.ps1');
const FETCH = read('fetch-caddy.ps1');
const EXPORT = read('export-offline-package.ps1');
const GITIGNORE = read('../.gitignore');

const indexIn = (text, needle, from = 0) => {
  const i = text.indexOf(needle, from);
  if (i < 0) throw new Error(`찾지 못했습니다: ${needle}`);
  return i;
};

describe('caddy/ 고정 값', () => {
  const version = PIN_VERSION.trim();
  const entries = PIN_SHA.split('\n').filter((l) => l.trim() !== '');

  it('CADDY_VERSION은 x.y.z 한 줄이다', () => {
    expect(PIN_VERSION).toMatch(/^\d+\.\d+\.\d+\n?$/);
  });

  it('해시 파일은 sha512sum 형식 두 줄이고, zip 항목 이름이 CADDY_VERSION과 같은 버전이다(버전만 바꾸면 깨진다)', () => {
    expect(entries).toHaveLength(2);
    for (const line of entries) expect(line).toMatch(/^[0-9a-f]{128} {2}\S+$/);
    const names = entries.map((l) => l.split('  ')[1]).sort();
    expect(names).toEqual(['caddy.exe', `caddy_${version}_windows_amd64.zip`].sort());
    const hashes = entries.map((l) => l.split('  ')[0]);
    expect(new Set(hashes).size).toBe(2);
  });

  it('내려받은 바이너리는 git에 올리지 않는다', () => {
    expect(GITIGNORE).toMatch(/^caddy\/windows-amd64\/$/m);
  });
});

describe('scripts/caddy-pin.ps1 — fetch와 export가 함께 쓰는 고정 값 파서', () => {
  it('Windows PowerShell 5.1에서 깨지지 않게 ASCII만 쓴다', () => {
    expect(HELPER).toMatch(/^[\x00-\x7f]*$/);
    expect(HELPER.startsWith('#Requires -Version 5.1')).toBe(true);
  });

  it('zip 항목 이름을 CADDY_VERSION에서 만들어 찾는다 — 버전과 해시가 따로 놀 수 없다', () => {
    expect(HELPER).toContain('$zipName = "caddy_${version}_windows_amd64.zip"');
    expect(HELPER).toMatch(/foreach \(\$name in @\(\$zipName, 'caddy\.exe'\)\)[\s\S]*?throw/);
    expect(HELPER).toMatch(/if \(\$entries\.Count -ne 2\)[\s\S]*?throw/);
    expect(HELPER).toMatch(/if \(\$entries\.ContainsKey\(\$name\)\) \{ throw/);
  });

  it('해시는 SHA-512로 계산해 소문자로 비교한다', () => {
    expect(HELPER).toContain("Get-FileHash -LiteralPath $Path -Algorithm SHA512).Hash.ToLowerInvariant()");
  });
});

describe('scripts/fetch-caddy.ps1 — 고정 해시로 검증한 뒤에만 배치한다', () => {
  it('ASCII·5.1 호환이고 공용 파서를 쓴다', () => {
    expect(FETCH).toMatch(/^[\x00-\x7f]*$/);
    expect(FETCH.startsWith('#Requires -Version 5.1')).toBe(true);
    expect(FETCH).toContain(". (Join-Path $PSScriptRoot 'caddy-pin.ps1')");
  });

  it('공식 GitHub 릴리스에서 HTTPS로만 받는다', () => {
    expect(FETCH).toContain('$releaseBase = "https://github.com/caddyserver/caddy/releases/download/v$($pin.Version)"');
    const urls = FETCH.match(/Invoke-WebRequest -Uri "([^"]+)"/g) ?? [];
    expect(urls.length).toBe(2);
    for (const u of urls) expect(u).toContain('$releaseBase/');
  });

  it('순서: zip 해시 → (다운로드 모드) 공식 checksums 대조 → 압축 해제 → exe 해시 → caddy version → 출력 폴더 교체', () => {
    const zipCheck = indexIn(FETCH, 'if ($zipSha -ne $pin.ZipSha512)');
    const sumsCheck = indexIn(FETCH, 'if ($official -ne $pin.ZipSha512)');
    const expand = indexIn(FETCH, 'Expand-Archive');
    const exeCheck = indexIn(FETCH, 'if ($exeSha -ne $pin.ExeSha512)');
    const run = indexIn(FETCH, '& $exe version');
    const versionCheck = indexIn(FETCH, 'if ($reportedVersion -ne "v$($pin.Version)")');
    const move = indexIn(FETCH, 'Move-Item -LiteralPath $staging -Destination $OutDir');
    const order = [zipCheck, sumsCheck, expand, exeCheck, run, versionCheck, move];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // 각 검사는 실패 시 중단한다.
    for (const at of [zipCheck, sumsCheck, exeCheck, versionCheck]) {
      expect(FETCH.slice(at, at + 250)).toMatch(/Stop-WithError/);
    }
    expect(FETCH).toMatch(/function Stop-WithError[\s\S]*?exit 1/);
  });

  it('checksums.txt 대조는 -ZipPath가 아닐 때(다운로드 모드) 항상 하고, 항목이 없어도 중단한다', () => {
    const sums = indexIn(FETCH, 'if (-not $ZipPath) {\n        $sumsName');
    expect(sums).toBeGreaterThan(indexIn(FETCH, 'if ($zipSha -ne $pin.ZipSha512)'));
    expect(FETCH).toMatch(/if \(-not \$official\) \{ Stop-WithError/);
  });

  it('출력 폴더는 옆의 .new에 채우고 복사본을 다시 대조한 뒤 교체한다 — 실패해도 반쯤 찬 폴더가 남지 않는다', () => {
    const recheck = indexIn(FETCH, 'if ((Get-Sha512 (Join-Path $staging "caddy.exe")) -ne $pin.ExeSha512)');
    const removeOld = indexIn(FETCH, 'Remove-Item -LiteralPath $OutDir -Recurse -Force');
    expect(recheck).toBeLessThan(removeOld);
    expect(FETCH).toMatch(/finally \{[\s\S]*?Remove-Item -LiteralPath \$tmp[\s\S]*?\$staging/);
  });
});

describe('export-offline-package.ps1 — caddy-host/ 패키징', () => {
  it('-ExcludeCaddyHost 스위치를 받고, 기본은 포함(필수)이다', () => {
    const params = EXPORT.match(/param\(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(params).toMatch(/\[switch\]\$ExcludeCaddyHost\s*=\s*\$false/);
    expect(EXPORT).toMatch(/if \(\$ExcludeCaddyHost\) \{[\s\S]*?\} else \{[\s\S]*?Read-CaddyPin/);
  });

  it('caddy.exe·LICENSE 존재와 고정 해시 대조는 패키지 폴더를 지우기 전에 하고, 실패하면 중단한다', () => {
    const exists = indexIn(EXPORT, 'foreach ($f in @("caddy.exe", "LICENSE"))');
    const hash = indexIn(EXPORT, 'if ($caddyExeSha -ne $caddyPin.ExeSha512) {');
    const removePackage = indexIn(EXPORT, 'Remove-Item -Recurse -Force $PackageDir');
    expect(exists).toBeLessThan(removePackage);
    expect(hash).toBeLessThan(removePackage);
    expect(EXPORT.slice(exists, exists + 400)).toMatch(/Write-Error[\s\S]*?exit 1/);
    expect(EXPORT.slice(hash, hash + 300)).toMatch(/Write-Error[\s\S]*?exit 1/);
    expect(EXPORT).toMatch(/try \{ \$caddyPin = Read-CaddyPin [^\n]*catch \{ Write-Error [^\n]*exit 1 \}/);
  });

  it('caddy-host/에 복사한 뒤 복사본을 다시 대조한다(검증한 경우에만 복사)', () => {
    const at = indexIn(EXPORT, 'if ($caddyPin) {\n    $caddyHostDest');
    const block = EXPORT.slice(at, EXPORT.indexOf('\n}\n', at));
    expect(block).toContain('Copy-Required (Join-Path $caddyHostSrcDir "caddy.exe") $caddyHostDest');
    expect(block).toContain('Copy-Required (Join-Path $caddyHostSrcDir "LICENSE")   $caddyHostDest');
    expect(block).toMatch(/if \(\(Get-Sha512 \(Join-Path \$caddyHostDest "caddy\.exe"\)\) -ne \$caddyPin\.ExeSha512\) \{[\s\S]*?exit 1/);
  });

  it('caddy-host/는 SHA256SUMS 생성보다 먼저 채운다(체크섬에 포함된다)', () => {
    expect(indexIn(EXPORT, 'Copy-Required (Join-Path $caddyHostSrcDir "caddy.exe")')).toBeLessThan(indexIn(EXPORT, 'Write-Step "Generating SHA256SUMS"'));
  });

  it('release-manifest.json에 caddyHost(포함 여부·버전·exe/zip SHA-512)를 기록한다', () => {
    const at = indexIn(EXPORT, 'caddyHost            = [ordered]@{');
    const block = EXPORT.slice(at, EXPORT.indexOf('\n    }\n', at));
    expect(block).toContain('included  = [bool]$caddyPin');
    for (const key of ['version', 'file', 'exeSha512', 'zipSha512', 'zipName']) {
      expect(block).toMatch(new RegExp(`${key}\\s*= if \\(\\$caddyPin\\) \\{ [^}]+ \\} else \\{ \\$null \\}`));
    }
  });
});
