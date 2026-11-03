import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// scripts/backup-caddy-ca.ps1 은 PowerShell + Docker 라 단위 테스트가 어렵다. 실제 동작은 시험용 GPG 키로 끝까지 실행해 확인했다
// (PowerShell 7과 Windows PowerShell 5.1 모두 → 복호화 → 새 볼륨에 복원 → 원본과 파일 4개 바이트 일치 → 잘못된 입력 5종은 종료 코드 1·
// 아카이브 미생성). 이 테스트는 그때 확인한 **안전 불변식**이 의도 없이 바뀌는 것을 막는다 — CA 비밀 키가 평문으로 디스크에 닿지 않는다,
// 원본 볼륨을 읽기 전용으로만 쓴다, 키 내용을 출력하지 않는다, 서버의 Windows PowerShell 5.1에서도 돈다, 패키지에 들어간다.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const SCRIPT = read('backup-caddy-ca.ps1');
const EXPORT = read('export-offline-package.ps1');
const PLAN = read('../docs/PRODUCTION_RELEASE_PLAN.md');

const indexOfOrFail = (needle, from = 0) => {
  const i = SCRIPT.indexOf(needle, from);
  if (i < 0) throw new Error(`backup-caddy-ca.ps1에서 찾지 못했습니다: ${needle}`);
  return i;
};

describe('backup-caddy-ca.ps1 — 비밀 키가 평문으로 남지 않는다', () => {
  it('암호화되지 않은 tar 는 컨테이너 메모리(/dev/shm)에만 만들고, 호스트로 나가는 파일은 gpg 출력뿐이다', () => {
    expect(SCRIPT).toContain('-cf /dev/shm/ca.tar');
    expect(SCRIPT).not.toMatch(/-cf\s+\/out/);
    expect(SCRIPT).toContain('--output /out/$OUT_FILE --encrypt /dev/shm/ca.tar');
    // /out 쓰기 가능 마운트는 아카이브를 만드는 두 경로(볼륨·-SourceDir)에 하나씩뿐이다(나머지 /out 마운트는 :ro).
    const writable = SCRIPT.match(/-v "\$\{outFull\}:\/out"/g) ?? [];
    expect(writable).toHaveLength(2);
  });

  it('gpg 는 공개 키 비대칭 암호화(--recipient --encrypt)이고 암호 입력이 필요 없다', () => {
    expect(SCRIPT).toMatch(/gpg --batch --yes --trust-model always --recipient \$GPG_RECIPIENT /);
    expect(SCRIPT).not.toMatch(/--symmetric|--passphrase|--decrypt/);
  });

  it('성공·실패와 관계없이 평문 tar 를 지운다(종료 코드는 보존)', () => {
    expect(SCRIPT).toContain('rc=$?; rm -f /dev/shm/ca.tar; exit $rc');
  });

  it('아카이브 생성에 실패하면 반쯤 만들어진 파일을 지우고 중단한다', () => {
    const fail = SCRIPT.match(/if \(\$LASTEXITCODE -ne 0 -or -not \(Test-Path \$archivePath\)[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fail).toMatch(/Remove-Item \$archivePath/);
    expect(fail).toMatch(/Stop-WithError/);
  });

  it('CA 볼륨은 항상 읽기 전용(:ro)으로 마운트한다', () => {
    const mounts = SCRIPT.match(/-v "\$\{caddyVolume\}:[^"]*"/g) ?? [];
    expect(mounts.length).toBeGreaterThanOrEqual(3);
    for (const m of mounts) expect(m).toMatch(/:\/data:ro"$/);
  });

  it('키 파일 내용을 읽어 출력하지 않는다 — cat 은 root.crt(공개 인증서)만 대상으로 한다', () => {
    const cats = SCRIPT.split('\n').filter((l) => /--entrypoint cat/.test(l));
    expect(cats).toHaveLength(1);
    expect(cats[0]).toContain('root.crt');
    expect(SCRIPT).not.toMatch(/cat[^\n]*\.key/);
    // 정보 파일에는 지문·파일 이름 같은 공개 정보만 쓴다.
    const info = SCRIPT.slice(indexOfOrFail('$info = @('), indexOfOrFail('Set-Content -Path $infoPath'));
    expect(info).not.toMatch(/\.key\b(?!,)/);
  });
});

describe('backup-caddy-ca.ps1 -SourceDir (호스트 Caddy 서비스의 CA 사본, 릴리스 B PR-4)', () => {
  // 실측(2026-11-03, 가짜 CA 4개·시험 키링): 5.1·7 모두 아카이브 생성 → 복호화한 파일 4개가 원본과 바이트 일치,
  // out 폴더에 평문 없음. 거부 4종(비관리자·경로에 junction·64 KiB 초과·SHA-256 불일치)은 종료 코드 1, 아카이브 없음.
  // 관리자 리허설(사용자 실행): 실제 C:\ProgramData\wr-caddy\data 를 5.1로 백업 → 설치 기록의 루트와 일치, 복호화한 4개가
  // 호스트 폴더·볼륨 백업과 모두 바이트 일치, 출력 폴더에 평문 없음.
  const src = () => SCRIPT.slice(indexOfOrFail('} else {\n    # Host folder:'), indexOfOrFail('$archivePath = Join-Path $outFull $outFile'));

  it('관리자 창에서만 동작하고, 경로의 모든 폴더·파일에서 junction/symlink를 거부하며 크기 상한을 둔다', () => {
    expect(SCRIPT).toMatch(/if \(-not \(Test-Admin\)\) \{ Stop-WithError '-SourceDir needs an elevated/);
    expect(SCRIPT).toContain("foreach ($d in @($chain + @((Join-Path $SourceDir 'pki'), (Join-Path $SourceDir 'pki\\authorities'), $hostCaDir))) {");
    // 드라이브 루트부터 -SourceDir 까지 모든 상위 폴더도 검사한다(상위 junction 도 읽기를 돌린다 — PR 리뷰 1회차 권고, 5.1·7 실측).
    expect(SCRIPT).toMatch(/while \(\$p\) \{\s*\$chain = @\(\$p\) \+ \$chain\s*\$parent = Split-Path -Parent \$p\s*if \(-not \$parent -or \$parent -eq \$p\) \{ break \}/);
    expect(SCRIPT.match(/-band \[System\.IO\.FileAttributes\]::ReparsePoint\) \{ Stop-WithError/g)).toHaveLength(2);
    expect(SCRIPT).toMatch(/if \(\$item\.Length -le 0 -or \$item\.Length -gt 65536\) \{ Stop-WithError/);
    expect(SCRIPT).toContain('$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SourceDir)');
  });

  it('평문은 호스트 디스크에 쓰지 않는다 — 표준입력(base64)으로 넘기고 컨테이너 /dev/shm 에서만 다시 만든다', () => {
    const s = src();
    expect(s).toContain('$payload | docker run -i --rm --entrypoint sh');
    expect(s).toContain('[Convert]::ToBase64String($hostFiles[$f])');
    expect(s).toContain('d=/dev/shm/caimport');
    expect(s).toContain('tar -C $d -cf /dev/shm/ca.tar local');
    expect(s).toContain('rm -rf $d /dev/shm/ca.tar; exit $rc');
    expect(s).not.toMatch(/-v "\$\{?(SourceDir|hostCaDir)/);    // 호스트 폴더를 바인드 마운트하지 않는다
    expect(SCRIPT).not.toMatch(/WriteAllBytes|Set-Content[^\n]*hostFiles|Out-File/);
    // 쓰고 나면 프로세스 메모리의 키 바이트를 지운다.
    expect(s).toContain('[Array]::Clear($hostFiles[$f], 0, $hostFiles[$f].Length)');
  });

  it('컨테이너가 파일 이름을 화이트리스트로 다시 검사하고, SHA-256이 원본과 다르면 암호화 전에 중단한다', () => {
    const s = src();
    expect(s).toContain("case $name in root.crt|root.key|intermediate.crt|intermediate.key) ;; *) exit 3 ;; esac;");
    expect(s).toContain('for p in root.crt:$H_RC root.key:$H_RK intermediate.crt:$H_IC intermediate.key:$H_IK; do');
    expect(s).toMatch(/if \[ \$ok = 1 \]; then echo IMPORT_OK && tar /);
    expect(s).toMatch(/if \(@\(\$importOut \| Where-Object \{ "\$_" -eq 'IMPORT_OK' \}\)\.Count -eq 0\) \{\s*Stop-WithError/);
  });

  it('컨테이너 sh 명령에 큰따옴표가 없다 — Windows PowerShell 5.1은 네이티브 인자 속 큰따옴표를 넘기지 못한다(실측)', () => {
    const cmd = SCRIPT.slice(indexOfOrFail('$importCmd = '), indexOfOrFail("exit $rc'", indexOfOrFail('$importCmd = ')));
    expect(cmd).not.toContain('"');
  });

  it('설치 기록(state\\install.json)의 루트 지문과 다르면 아무것도 쓰지 않고 중단한다', () => {
    expect(SCRIPT).toMatch(/if \(\$installed -and \$installed -ne \$thumb256\) \{ Stop-WithError/);
    expect(indexOfOrFail('if ($installed -and $installed -ne $thumb256)')).toBeLessThan(indexOfOrFail("Write-Step 'Create the encrypted archive'"));
  });
});

describe('backup-caddy-ca.ps1 — 입력 검증·순서', () => {
  it('공개 키(수신자)가 없으면 중단하고, 키링에 그 키가 있는지 아카이브 생성 전에 확인한다', () => {
    expect(SCRIPT).toMatch(/if \(-not \$Recipient\)\s*\{ Stop-WithError/);
    const keyCheck = indexOfOrFail('gpg --batch --list-keys $Recipient');
    const archive = indexOfOrFail('Create the encrypted archive');
    expect(keyCheck).toBeLessThan(archive);
  });

  it('CA 파일 4개가 모두 있는지 확인한 뒤에만 진행한다', () => {
    expect(SCRIPT).toMatch(/\$required = @\('root\.crt', 'root\.key', 'intermediate\.crt', 'intermediate\.key'\)/);
    const missing = indexOfOrFail('MISSING:');
    const archive = indexOfOrFail('Create the encrypted archive');
    expect(missing).toBeLessThan(archive);
  });

  it('컨테이너 sh 명령줄에 들어가는 값은 안전한 문자만 허용한다(따옴표·공백·세미콜론 거부)', () => {
    expect(SCRIPT).toMatch(/-notmatch '\^\[A-Za-z0-9@\._\+:-\]\+\$'/);
    for (const name of ['Project', 'Recipient', 'ImageVersion', 'GnupgVolume', 'output file name']) {
      expect(SCRIPT).toContain(`Assert-SafeToken '${name}'`);
    }
  });

  it('기본 프로젝트는 wr-prod 이고 CA 볼륨 이름은 <Project>_caddy_data 다', () => {
    expect(SCRIPT).toMatch(/\[string\]\$Project\s*=\s*'wr-prod'/);
    expect(SCRIPT).toContain('$caddyVolume = "${Project}_caddy_data"');
  });

  it('env 파일에서는 WR_VERSION 과 BACKUP_GPG_RECIPIENT 두 키만 읽는다', () => {
    const keys = [...SCRIPT.matchAll(/Get-EnvValue \$EnvFile '([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual(['BACKUP_GPG_RECIPIENT', 'WR_VERSION']);
  });
});

describe('backup-caddy-ca.ps1 — 서버(Windows PowerShell 5.1)에서도 돈다', () => {
  it('최소 요구 버전은 5.1 이다', () => {
    expect(SCRIPT.startsWith('#Requires -Version 5.1')).toBe(true);
  });

  it('스크립트에 ASCII 가 아닌 문자가 없다 — 5.1은 BOM 없는 UTF-8 한글을 잘못 읽는다', () => {
    const bad = [...SCRIPT].filter((c) => c.charCodeAt(0) > 0x7f);
    expect(bad).toEqual([]);
  });

  it('PowerShell 7 전용 문법(??, ?., 삼항, -SkipHttpErrorCheck, 파이프라인 체인)을 쓰지 않는다', () => {
    expect(SCRIPT).not.toMatch(/\?\?|\?\.|\s\?\s.+\s:\s|-SkipHttpErrorCheck|\)\s*&&\s|\)\s*\|\|\s/);
  });

  it('네이티브 명령은 Invoke-Native(EAP=Continue)로 감싼다 — 5.1은 stderr 경고에도 중단한다', () => {
    // Invoke-Native { ... } 블록(중괄호 균형)을 걷어낸 나머지에는 docker 호출이 하나도 남지 않아야 한다.
    let rest = SCRIPT;
    for (;;) {
      const start = rest.indexOf('Invoke-Native {');
      if (start < 0) break;
      let depth = 0;
      let end = -1;
      for (let i = rest.indexOf('{', start); i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        else if (rest[i] === '}' && --depth === 0) { end = i; break; }
      }
      if (end < 0) throw new Error('Invoke-Native 블록의 중괄호가 맞지 않습니다');
      rest = rest.slice(0, start) + rest.slice(end + 1);
    }
    const outside = rest.split('\n').filter((l) => /^\s*(?:&\s*)?docker\s/.test(l) && !l.trim().startsWith('#'));
    expect(outside).toEqual([]);
    // 감싼 호출이 실제로 여러 개 있다는 것도 확인한다(위 검사가 빈 껍데기로 통과하지 않도록).
    expect((SCRIPT.match(/Invoke-Native \{/g) ?? []).length).toBeGreaterThanOrEqual(8);
  });
});

describe('패키지·문서', () => {
  it('오프라인 패키지의 scripts\\ 로 복사된다(서버에서 쓰려면 패키지에 있어야 한다)', () => {
    const helper = EXPORT.match(/\$helperScripts\s*=\s*@\(([^)]*)\)/)?.[1] ?? '';
    expect(helper).toContain('"backup-caddy-ca.ps1"');
  });

  it('볼륨 정책 표가 Caddy 데이터 볼륨을 "재생성 가능"이라고 적지 않는다 — 잃으면 모든 PC에 루트를 다시 설치해야 한다', () => {
    const row = PLAN.split('\n').find((l) => l.includes('`wr-prod_caddy_data`') && l.startsWith('|')) ?? '';
    expect(row).not.toContain('재생성 가능');
    expect(row).toContain('영구 보존');
    expect(PLAN).toContain('### 7-1. Caddy 내부 CA 키 백업·복구');
  });

  it('릴리스 체크리스트에 CA 키 백업 항목이 있다', () => {
    expect(PLAN).toMatch(/- \[ \] Caddy 내부 CA 키 백업 완료\(7-1\)/);
  });
});
