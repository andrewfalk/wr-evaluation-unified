import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// 릴리스 B PR-3a — 호스트 Caddy 시범 설치(scripts/install-caddy-host.ps1 + caddy/Caddyfile.host.template).
// PowerShell·서비스·ACL은 CI에서 실행할 수 없다. 실제 동작은 이 PC에서 확인했다:
//  - 템플릿: v2.11.7 `caddy validate`, `caddy run`으로 X-Forwarded-For 전달·리다이렉트 포트 유지·TCP 2개만(UDP·2019 없음)·
//    정상 200과 업스트림 없는 502 모두 access.log·caddy.log에 쿼리 표식 0건
//  - 스크립트: 5.1·7 구문 분석, -WhatIf 전 단계 통과(아무것도 만들지 않음), 잘못된 지문·8443·비관리자 거부,
//  - 관리자 리허설(사용자가 관리자 PowerShell로 실행, 2026-11-03): 7·5.1 각각 설치→상태→제거, 강제 종료 뒤 자동 재시작,
//    재설치 거부, 기존 CA 복사본 일치 경로, 감사 로그 IP가 출발지별(루프백·LAN)로 남고 Docker 경로는 172.x 그대로,
//    서비스 로그 쿼리 표식 0건. 비관리자로 data 읽기·bin 쓰기 거부, 2019 연결 거부, 8443 무영향 확인
// PR-3b — 8443 전환(-Cutover)·되돌리기(-Rollback)·앱 포트 반영(-Reconfigure). 이 PC에서 확인한 것:
//  - 실측: 셸 변수가 Compose v2.22.0(운영과 같은 공식 바이너리)·v5.4 모두 --env-file보다 우선, `config --format json`의
//    volumes.<키>.name = 실제 볼륨 이름, `up -d --no-deps caddy`는 app·postgres 컨테이너 ID 불변, Docker Desktop은 8443을
//    약 1초에 놓음, PowerShell 7에서 SetEnvironmentVariable(k, $null)은 빈 변수를 남김([NullString]::Value로 지움),
//    env 임시 파일은 생성 순간부터 원본 ACL·독점(다른 프로세스 열기 = 공유 위반), 교체 뒤 ACL·백업 ACL = 원본
//  - 헬퍼 단위 시험(5.1·7, 스크립트 AST에서 함수만 꺼내 실행): env 편집(BOM·CRLF·LF·혼합 줄바꿈·주석·따옴표·중복 키 거부·
//    교체 실패 시 임시 파일 정리·되돌리면 원래 바이트), 셸 변수 감지, 대상 구성 검사(다른 CA 볼륨·셸 도메인·앱 포트 거부),
//    실행 중인 caddy 컨테이너 라벨 대조
//  - 관리자 리허설(사용자 실행, 2026-11-03, 검증 스택): 시범 설치 → 전환(5.1) → 8443 접속 IP가 127.0.0.1·LAN 주소로 기록
//    (Docker 18443 경로는 172.20.0.1, LAN에서 18443 접속 불가) → 전체 `up -d` 뒤에도 host 모드 유지 → 앱 포트 13002 변경 시
//    Status 실패 → -Reconfigure(5.1·7) → 거부 시험(host에서 Uninstall, 손으로 바꾼 env에서 Rollback, 셸 WR_CADDY_HTTPS_BIND·
//    WR_DOMAIN, override 파일 누락) → 롤백 뒤 다른 env 키 보존·DISABLED·8443 = Docker(172.x) → 서비스 기동 실패를 주입하자
//    Docker로 자동 복귀(env 복원·방화벽 제거·8443 200) → 재전환 → 재롤백 → docker 모드에서 제거
// 이 테스트는 그때 확인한 안전 불변식이 의도 없이 바뀌는 것을 막는다.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), 'utf8').replace(/\r\n/g, '\n');
const SCRIPT = read('install-caddy-host.ps1');
// "쓰지 않는다" 검사용: 도움말 블록(<# ... #>)과 줄 전체 주석을 뺀 코드.
const CODE = SCRIPT.replace(/<#[\s\S]*?#>/, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const TEMPLATE = read('../caddy/Caddyfile.host.template');
const EXPORT = read('export-offline-package.ps1');

const indexIn = (text, needle, from = 0) => {
  const i = text.indexOf(needle, from);
  if (i < 0) throw new Error(`찾지 못했습니다: ${needle}`);
  return i;
};
const fnBody = (name) => {
  const start = indexIn(SCRIPT, `function ${name} {`);
  const end = SCRIPT.indexOf('\n}\n', start);
  return SCRIPT.slice(start, end);
};
// 인자 목록이 있는 함수(`function Name([string]$x) {`)도 찾는다.
const fnAny = (name) => {
  const m = new RegExp(`function ${name}[ (]`).exec(SCRIPT);
  if (!m) throw new Error(`찾지 못했습니다: function ${name}`);
  return SCRIPT.slice(m.index, SCRIPT.indexOf('\n}\n', m.index));
};

describe('caddy/Caddyfile.host.template', () => {
  it('관리 API를 끄고(admin off), HTTP/3(UDP)를 끄고, OS 신뢰 저장소를 건드리지 않는다', () => {
    expect(TEMPLATE).toMatch(/^\tadmin off$/m);
    expect(TEMPLATE).toMatch(/servers \{\s*protocols h1 h2\s*\}/);
    expect(TEMPLATE).toMatch(/^\tskip_install_trust$/m);
  });

  it('기존 Docker Caddy와 같은 내부 CA 설정(이름·중간 인증서·서버 인증서 수명)을 쓴다', () => {
    const docker = read('../caddy/Caddyfile');
    for (const line of ['name "WR Evaluation Internal CA"', 'intermediate_lifetime 365d', 'lifetime 6d', 'ca local']) {
      expect(docker).toContain(line);
      expect(TEMPLATE).toContain(line);
    }
  });

  it('저장소·로그·사이트·업스트림은 설치 스크립트가 채우는 자리표시자다', () => {
    expect(TEMPLATE).toContain('storage file_system __DATA_DIR__');
    expect(TEMPLATE).toContain('https://__DOMAIN__:__HTTPS_PORT__ {');
    expect(TEMPLATE).toContain('reverse_proxy 127.0.0.1:__APP_PORT__');
    expect(TEMPLATE).toContain('http://__DOMAIN__:__HTTP_PORT__ {');
    // 리다이렉트는 HTTPS 포트를 유지한다(기존 Docker 설정은 :443으로 보냈다).
    expect(TEMPLATE).toContain('redir https://{host}:__HTTPS_PORT__{uri} permanent');
    // 스크립트가 아는 자리표시자만 쓴다(남으면 설치가 중단되므로 주석에도 같은 형태를 쓰지 않는다).
    const used = new Set(TEMPLATE.match(/__[A-Z_]+__/g));
    expect([...used].sort()).toEqual(['__APP_PORT__', '__DATA_DIR__', '__DOMAIN__', '__HTTPS_PORT__', '__HTTP_PORT__', '__LOG_DIR__']);
    for (const p of used) expect(SCRIPT).toContain(`Replace('${p}'`);
  });

  it('요청을 기록하는 로거(기본·접속) 전부가 URI·Referer의 쿼리 문자열을 지운다 — 환자 검색이 ?q=로 이름을 보낸다', () => {
    // Codex 계획 리뷰 1회차: 502 같은 처리 오류는 기본 로거가 원본 요청과 함께 기록한다.
    const outputs = TEMPLATE.split('\n').filter((l) => /^\s*output file /.test(l));
    expect(outputs.length).toBe(2);
    // 각 `\tlog {` 블록을 같은 들여쓰기의 닫는 `\t}`에서 잘라, 블록마다 자기 필터가 있는지 본다.
    const logBlocks = TEMPLATE.split('\n\tlog {\n').slice(1).map((rest) => rest.slice(0, indexIn(rest, '\n\t}\n')));
    expect(logBlocks.length).toBe(2);
    for (const block of logBlocks) {
      expect(block).toMatch(/output file __LOG_DIR__\/\w+\.log \{/);
      expect(block).toMatch(/format filter \{\s*wrap json\s*fields \{\s*request>uri regexp \[\?\]\.\*\$ ""\s*request>headers>Referer regexp \[\?\]\.\*\$ ""/);
      expect(block).toMatch(/roll_size 100MiB\s*roll_keep 10\s*roll_keep_for 2160h/);
    }
    expect(logBlocks.map((b) => b.match(/output file __LOG_DIR__\/(\w+)\.log/)[1]).sort()).toEqual(['access', 'caddy']);
  });
});

describe('scripts/install-caddy-host.ps1 — 기본 성질', () => {
  it('Windows PowerShell 5.1 호환·ASCII, -WhatIf를 지원한다', () => {
    expect(SCRIPT).toMatch(/^[\x00-\x7f]*$/);
    expect(SCRIPT.startsWith('#Requires -Version 5.1')).toBe(true);
    expect(SCRIPT).toContain('[CmdletBinding(SupportsShouldProcess = $true');
    // 모든 변경은 스크립트의 ShouldProcess를 거친다.
    expect(SCRIPT).toContain('$ScriptCmdlet = $PSCmdlet');
    expect(CODE).not.toMatch(/\$PSCmdlet\.ShouldProcess/);
  });

  it('-Install은 시범 포트만(8443/8080 거부). 컨테이너 변경은 caddy 재생성 하나뿐이고 env 파일은 Write-EnvKeys로만 쓴다', () => {
    expect(SCRIPT).toContain('$ReservedPorts  = @(8443, 8080)');
    expect(SCRIPT).toMatch(/if \(\$ReservedPorts -contains \$p\) \{ throw/);
    expect(SCRIPT).toMatch(/\[int\]\$HttpsPort\s*=\s*9443/);
    expect(SCRIPT).toMatch(/\[int\]\$HttpPort\s*=\s*9080/);
    // 사용자 결정(2026-11-03): 재생성은 caddy만 — 앱·DB는 건드리지 않는다. compose 하위 명령은 config와 이것뿐.
    expect(CODE.match(/'up'/g)).toHaveLength(1);
    expect(CODE).toContain("@(Get-ComposeArgs) + @('up', '-d', '--no-deps', 'caddy')");
    expect(CODE).not.toMatch(/'(down|stop|restart|rm|kill|pull|build|create)'/);
    expect(CODE).not.toMatch(/docker (stop|restart|kill|volume rm|rm -f)/);
    expect(fnBody('Invoke-Install')).not.toMatch(/Write-EnvKeys|Get-ComposeArgs|Invoke-ComposeUpCaddy/);
    // env 파일 쓰기 경로는 Write-EnvKeys의 File.Replace 하나.
    expect(CODE).not.toMatch(/(Set|Add|Out)-Content[^\n]*\$EnvFile|WriteAllText\(\$EnvFile|WriteAllBytes/);
    expect(CODE.match(/\[System\.IO\.File\]::Replace\(/g)).toHaveLength(1);
    expect(fnAny('Write-EnvKeys')).toContain('[System.IO.File]::Replace($tmp, $Path, $backup)');
  });

  it('설치 폴더에는 공백이 없다(서비스 명령줄에 따옴표 중첩이 필요 없고, 따옴표 없는 경로 문제도 없다)', () => {
    expect(SCRIPT).toContain("$Root           = 'C:\\ProgramData\\wr-caddy'");
    expect(SCRIPT).toMatch(/if \(\$Root -match '\[\\s"\]'\) \{ throw/);
  });

  it('상대 경로는 PowerShell 현재 위치 기준으로 해석한다(PR-2 교훈)', () => {
    expect(SCRIPT).toContain('$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)');
    expect(SCRIPT).toContain('$EnvFile = Resolve-UserPath $EnvFile');
    expect(SCRIPT).toContain('$infoPath = Resolve-UserPath $CaBackupInfo');
    expect(CODE).not.toMatch(/\[System\.IO\.Path\]::GetFullPath\(/);
  });

  it('해시는 .NET으로 계산한다 — 5.1의 Get-FileHash는 -WhatIf에서 값을 내지 않는다', () => {
    expect(CODE).not.toMatch(/Get-FileHash\s/);
    expect(SCRIPT).toContain("[System.Security.Cryptography.HashAlgorithm]::Create($Algorithm)");
  });

  it('설치·제거·전환·롤백·재구성은 관리자 권한을 요구한다(-WhatIf 제외)', () => {
    for (const fn of ['Invoke-Install', 'Invoke-Uninstall', 'Invoke-Cutover', 'Invoke-Rollback', 'Invoke-Reconfigure']) {
      expect(fnBody(fn)).toMatch(/if \(-not \$whatIf -and -not \(Test-Admin\)\) \{ throw/);
    }
  });
});

describe('install-caddy-host.ps1 -Install — CA 가드와 순서', () => {
  const body = () => fnBody('Invoke-Install');

  it('지문 3중 대조: 클라이언트 지문(필수) = CA 백업 info = Docker 볼륨 — 하나라도 다르면 아무것도 만들기 전에 중단', () => {
    const b = body();
    expect(SCRIPT).toMatch(/\[Parameter\(ParameterSetName = 'Install', Mandatory = \$true\)\]\[string\]\$ExpectedRootSha256/);
    expect(SCRIPT).toMatch(/\[Parameter\(ParameterSetName = 'Install', Mandatory = \$true\)\]\[string\]\$CaBackupInfo/);
    const backup = indexIn(b, "if ((ConvertTo-Fingerprint $info['Root SHA-256']) -ne $fp) { throw");
    const archive = indexIn(b, "if ((Get-FileHashHex $archive 'SHA256') -ne $info['Archive SHA-256'].ToLowerInvariant()) {");
    const volume = indexIn(b, "if (-not $volCert -or (Get-CertFingerprint $volCert) -ne $fp) { throw");
    const firstChange = indexIn(b, "Write-Step \"Folders and ACLs ($Root)\"");
    for (const at of [backup, archive, volume]) expect(at).toBeLessThan(firstChange);
  });

  it('원본 볼륨은 항상 읽기 전용(:ro)으로만 마운트한다', () => {
    const mounts = SCRIPT.match(/-v "\$\(\$script:CaVolume\):\/data[^"]*"/g) ?? [];
    expect(mounts.length).toBe(2);
    for (const m of mounts) expect(m).toMatch(/:\/data:ro"$/);
  });

  it('ACL을 CA 복사보다 먼저 설정·검증하고, data·logs는 사용자 접근 없음(상속 끊음)', () => {
    const b = body();
    const acl = indexIn(b, "Invoke-Icacls @($Root, '/inheritance:r'");
    const verify = indexIn(b, 'ACL check failed, others can read');
    const copy = indexIn(b, 'docker cp');
    expect(acl).toBeLessThan(copy);
    expect(verify).toBeLessThan(copy);
    expect(b).toContain("Invoke-Icacls @($d, '/inheritance:r', '/grant:r', \"*${SidAdmins}:(OI)(CI)F\", \"*${SidSystem}:(OI)(CI)F\", \"*${SidLocalService}:(OI)(CI)M\")");
    // 사용자는 SID로 지정한다(Windows 언어에 따라 그룹 이름이 다르다).
    expect(SCRIPT).toContain("$SidUsers        = 'S-1-5-32-545'");
  });

  it('data·logs는 폴더를 먼저 제한한 뒤 내용물만 상속으로 되돌린다 — 재설치 때 기존 CA 키가 Users 읽기를 상속하는 순간이 없다', () => {
    // Codex PR 리뷰 1회차: 폴더 자체를 /reset하면 잠깐 루트의 Users:RX를 상속한다.
    const b = body();
    const from = indexIn(b, 'foreach ($d in @($DataDir, $LogDir)) {\n                Invoke-Icacls');
    const loop = b.slice(from, indexIn(b, '\n            }\n', from));
    const restrict = indexIn(loop, "Invoke-Icacls @($d, '/inheritance:r'");
    const childReset = indexIn(loop, "foreach ($child in @(Get-ChildItem -LiteralPath $d -Force)) { Invoke-Icacls @($child.FullName, '/reset'");
    expect(restrict).toBeLessThan(childReset);
    expect(loop).not.toMatch(/Invoke-Icacls @\(\$d, '\/reset'/);
    // /grant:r는 세 계정만 바꾸므로, 그 밖의 직접 허용 ACE는 지운다(예전 /reset이 하던 일).
    expect(loop.slice(restrict, childReset)).toContain('Remove-ForeignAllowAce $d @($SidAdmins, $SidSystem, $SidLocalService)');
  });

  it('미리 만들어진 설치 루트의 개별 사용자 ACE도 지우고, 검사는 허용 SID 목록 밖을 모두 위반으로 본다', () => {
    // Codex PR 리뷰 2회차: ProgramData는 일반 사용자가 폴더를 만들 수 있고 만든 사람이 소유자가 된다.
    // 광범위 그룹 4개만 보던 검사는 그 사용자 SID의 (OI)(CI)F를 놓쳐 bin의 caddy.exe 교체가 가능했다.
    const b = body();
    const rootGrant = indexIn(b, "Invoke-Icacls @($Root, '/inheritance:r'");
    const rootClean = indexIn(b, 'Remove-ForeignAllowAce $Root @($SidAdmins, $SidSystem, $SidLocalService, $SidUsers)');
    const binReset = indexIn(b, "foreach ($d in @($BinDir, $StateDir)) { Invoke-Icacls @($d, '/reset'");
    expect(rootGrant).toBeLessThan(rootClean);
    expect(rootClean).toBeLessThan(binReset);
    const paramFn = (name) => {
      const start = indexIn(SCRIPT, `function ${name}(`);
      return SCRIPT.slice(start, indexIn(SCRIPT, '\n}\n', start));
    };
    const remover = paramFn('Remove-ForeignAllowAce');
    expect(remover).toContain('GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])');
    expect(remover).toContain("Invoke-Icacls @($Path, '/remove:g', \"*$sid\")");
    // 허용 목록: 쓰기는 Administrators·SYSTEM만, data·logs 읽기는 여기에 서비스 계정만.
    expect(SCRIPT).toContain('$Writers         = @($SidAdmins, $SidSystem)');
    expect(SCRIPT).toContain('$DataReaders     = @($SidAdmins, $SidSystem, $SidLocalService)');
    expect(CODE).not.toMatch(/Get-BroadAccess|BroadSids/);
    const checker = paramFn('Get-ForeignAccess');
    expect(checker).toContain('GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])');
    expect(checker).toContain('if ($AllowedSids -contains $ace.IdentityReference.Value) { continue }');
    // 관리자 권한으로 caddy.exe를 실행(validate)하기 직전에 실행 파일·설정 파일 자체도 검사한다.
    const fileCheck = indexIn(b, 'foreach ($f in @($ExeDest, $ConfigDest)) {\n                $foreign = @(Get-ForeignAccess $f $WriteRights $Writers)');
    expect(fileCheck).toBeLessThan(indexIn(b, '& $ExeDest validate'));
    expect(fnBody('Invoke-Status')).toContain('foreach ($d in @($Root, $BinDir, $StateDir, $ExeDest, $ConfigDest)) {');
  });

  it('미리 만든 junction·남이 소유한 설치 루트는 거부하고, 재귀(/T) 변경 전에 루트를 잠근 뒤 링크가 없는지 본다', () => {
    // Codex PR 리뷰 3회차: 루트를 사용자 폴더로 향하는 junction으로 미리 만들면 ACL 검사 뒤 대상을 바꿔
    // 관리자 권한 caddy 실행을 가로챌 수 있고, 관리자 icacls /T가 링크를 따라 다른 폴더를 바꿀 수 있다.
    const paramFn = (name) => {
      const start = indexIn(SCRIPT, `function ${name}`);
      return SCRIPT.slice(start, indexIn(SCRIPT, '\n}\n', start));
    };
    const trust = paramFn('Get-ExistingRootProblem');
    expect(trust).toContain('[System.IO.FileAttributes]::ReparsePoint) { return "$Root is a junction or symbolic link" }');
    expect(trust).toContain('if ($Writers -notcontains $owner) { return');
    expect(trust).toContain('@(Get-ForeignAccess $Root $WriteRights $Writers)');
    const links = paramFn('Get-ReparsePoints');
    expect(links).not.toMatch(/-Recurse/);   // 5.1의 -Recurse는 junction을 따라 내려간다
    expect(links).toMatch(/ReparsePoint\) \{ \$hits \+= \$i\.FullName; continue \}/);

    const b = body();
    const preCheck = indexIn(b, '$rootProblem = Get-ExistingRootProblem');
    expect(b.slice(preCheck, preCheck + 200)).toMatch(/if \(\$rootProblem\) \{\s*throw/);
    expect(preCheck).toBeLessThan(indexIn(b, "ShouldProcess($Root, 'Create folders"));
    const acl = b.slice(indexIn(b, "ShouldProcess($Root, 'Create folders"), indexIn(b, "Write-Ok 'ACLs set and verified'"));
    // Codex PR 리뷰 4회차: 생성 단계가 Test-Path로 다시 보면, 사전 검사 뒤 생긴 junction을 "기존 루트"로
    // 받아들여 icacls가 먼저 돈다. 사전 검사 때 본 존재 여부를 그대로 쓰고, 없었으면 -Force 없이 만든다.
    expect(b.slice(preCheck - 120, preCheck)).toContain('$rootExisted = Test-Path -LiteralPath $Root');
    expect(acl).toMatch(/if \(-not \$rootExisted\) \{\s*New-Item -ItemType Directory \$Root -ErrorAction Stop \| Out-Null\s*\} else \{\s*\$rootProblem = Get-ExistingRootProblem -MustExist\s*if \(\$rootProblem\) \{ throw/);
    // Codex PR 리뷰 5회차: 한 번 본 루트가 사라진 것은 "없음 = 문제없음"이 아니라 문제다
    // (사용자 소유 폴더를 지웠다가 재검사 직후 junction으로 되살릴 수 있다).
    expect(b).toContain('$rootProblem = Get-ExistingRootProblem -MustExist:$rootExisted');
    expect(trust).toMatch(/if \(-not \(Test-Path -LiteralPath \$Root\)\) \{\s*if \(\$MustExist\) \{ return "[^"]+" \}\s*return \$null\s*\}/);
    expect(acl).not.toMatch(/New-Item[^\n]*-Force[^\n]*\$Root\b(?!\\)/);
    const lockOwner = indexIn(acl, "Invoke-Icacls @($Root, '/setowner', \"*$SidAdmins\", '/C', '/Q')");
    expect(acl.slice(0, lockOwner)).not.toMatch(/Test-Path -LiteralPath \$Root/);
    const empty = indexIn(acl, 'if (-not $rootExisted -and @(Get-ChildItem -LiteralPath $Root -Force).Count -gt 0) {');
    const scan = indexIn(acl, '$links = @(Get-ReparsePoints $Root)');
    const firstRecursive = acl.search(/'\/T'/);
    expect(lockOwner).toBeLessThan(empty);
    expect(empty).toBeLessThan(scan);
    expect(scan).toBeLessThan(firstRecursive);
    expect(acl.slice(scan, scan + 200)).toMatch(/if \(\$links\.Count -gt 0\) \{ throw/);

    // 제거·상태 점검도 같은 검사를 한다(제거의 파일 삭제가 링크를 따라가지 않게).
    const un = fnBody('Invoke-Uninstall');
    expect(indexIn(un, 'Get-ExistingRootProblem')).toBeLessThan(indexIn(un, 'Remove-Item'));
    expect(indexIn(un, 'Get-ReparsePoints $d')).toBeLessThan(indexIn(un, 'Remove-Item'));
    const st = fnBody('Invoke-Status');
    expect(st).toMatch(/if \(\$rootProblem\) \{ Write-Fail [^\n]*\$problems\+\+ \}/);
    expect(st).toMatch(/\$links = @\(Get-ReparsePoints \$Root\)[\s\S]*?if \(\$links\.Count -gt 0\) \{ Write-Fail [^\n]*\$problems\+\+/);
  });

  it('복사본 지문을 대조한 뒤에만 local로 이름을 바꾸고, 다르면 복사본을 지운다. 기존 local은 덮어쓰지 않는다', () => {
    const b = body();
    const check = indexIn(b, "if ((Get-PemFileFingerprint (Join-Path $CaIncoming 'root.crt')) -ne $fp) {");
    const rename = indexIn(b, "Rename-Item -LiteralPath $CaIncoming -NewName 'local'");
    expect(check).toBeLessThan(rename);
    expect(b.slice(check, rename)).toMatch(/Remove-Item -LiteralPath \$CaIncoming -Recurse -Force\s*throw/);
    expect(b).toMatch(/if \(\$have -ne \$fp\) \{ throw "\$CaDir already holds a DIFFERENT CA/);
    // 복사는 local이 없을 때만.
    expect(b).toMatch(/if \(-not \(Test-Path -LiteralPath \$CaDir\)\) \{\s*if \(\$ScriptCmdlet\.ShouldProcess\(\$CaDir/);
  });

  it('caddy validate는 CA를 놓은 뒤에 돌리고(새 CA 생성 방지), 끝나고 루트가 그대로인지 다시 본다', () => {
    const b = body();
    const rename = indexIn(b, "Rename-Item -LiteralPath $CaIncoming -NewName 'local'");
    const validate = indexIn(b, 'validate --config $ConfigDest --adapter caddyfile');
    expect(rename).toBeLessThan(validate);
    expect(b.slice(validate, validate + 400)).toContain("if ((Get-PemFileFingerprint (Join-Path $CaDir 'root.crt')) -ne $fp) { throw");
  });

  it('caddy.exe는 패키지 매니페스트(또는 저장소 고정 값)의 SHA-512와 대조하고, 복사본도 다시 대조한다', () => {
    const b = body();
    expect(b).toContain('$expectedExeSha = ([string]$manifest.caddyHost.exeSha512).ToLowerInvariant()');
    expect(b).toContain('$expectedExeSha = $pin.ExeSha512');
    expect(b).toContain("if ((Get-Sha512File $srcExe) -ne $expectedExeSha) { throw");
    expect(b).toContain("if ((Get-Sha512File $ExeDest) -ne $expectedExeSha) { throw");
  });

  it('같은 이름의 서비스나 방화벽 그룹이 이미 있으면 덮어쓰지 않고 중단한다', () => {
    const b = body();
    expect(b).toMatch(/if \(\$existing\) \{ throw "A service named '\$ServiceName' already exists/);
    expect(b).toMatch(/if \(\$oldRules\.Count -gt 0\) \{ throw/);
    expect(indexIn(b, 'if ($existing) { throw')).toBeLessThan(indexIn(b, "Write-Step \"Folders and ACLs ($Root)\""));
  });

  it('서비스는 sc.exe로 LocalService·자동 시작·실패 시 재시작, 계정과 명령줄을 등록 뒤 다시 확인한다', () => {
    const b = body();
    expect(b).toContain("& sc.exe create $ServiceName 'binPath=' $binPath 'start=' 'auto' 'obj=' 'NT AUTHORITY\\LocalService'");
    expect(b).toContain("& sc.exe failure $ServiceName 'reset=' '86400' 'actions=' 'restart/5000/restart/5000/restart/60000'");
    expect(b).toMatch(/if \(-not \$svc -or \$svc\.StartName -notmatch 'LocalService'\) \{ throw/);
    expect(b).toMatch(/if \(\$svc\.PathName -ne \$binPath\) \{ throw/);
    // Caddy가 서비스 프로필에 autosave.json 등을 남기지 않게 data 아래로 돌린다.
    expect(b).toMatch(/XDG_CONFIG_HOME=\$\(Join-Path \$DataDir/);
  });

  it('기동 뒤 HTTPS 체인 루트 = 기대 지문, 리스너는 시범 TCP 2개뿐(UDP·2019 없음)을 확인한다', () => {
    const b = body();
    expect(b).toMatch(/if \(\$probe\.ChainRoot -ne \$fp\) \{ throw/);
    expect(b).toMatch(/if \(\$udp\.Count -gt 0\) \{ throw/);
    expect(b).toMatch(/LocalPort 2019[^\n]*\{ throw/);
    expect(SCRIPT).toContain('[System.Security.Authentication.SslProtocols]::Tls12');
  });

  it('TLS 프로브는 콜백 안에서 인증서 원본 바이트를 복사한다 — 5.1(.NET Framework)은 콜백이 끝나면 핸들을 해제한다', () => {
    // 관리자 리허설에서 5.1 Status가 "The chain context handle is invalid"로 실패해 찾은 결함.
    const start = indexIn(SCRIPT, 'function Invoke-TlsProbe(');
    const probe = SCRIPT.slice(start, indexIn(SCRIPT, '\n}\n', start));
    const cb = probe.slice(indexIn(probe, 'RemoteCertificateValidationCallback]'), indexIn(probe, 'return $true'));
    expect(cb).toContain('$cert.GetRawCertData()');
    expect(cb).toContain('.Certificate.RawData');
    expect(probe).toContain('X509Certificate2 (,$script:probeLeafRaw)');
    expect(probe).not.toMatch(/X509Certificate2 \(\$script:probeLeaf\)/);
  });

  it('TLS 프로브는 모든 단계에 제한 시간이 있고, 체인 검증 결과와 이름 불일치를 실패로 반영한다', () => {
    // Codex PR 리뷰 1회차: 응답하지 않는 업스트림에서 설치가 롤백 전에 멈춤 / Build 결과를 버림.
    const start = indexIn(SCRIPT, 'function Invoke-TlsProbe(');
    const probe = SCRIPT.slice(start, indexIn(SCRIPT, '\n}\n', start));
    expect(probe).toContain('$client.ReceiveTimeout = $TimeoutMs');
    expect(probe).toContain('$client.SendTimeout = $TimeoutMs');
    expect(probe).toMatch(/BeginConnect\([^\n]*\n\s*if \(-not \$connect\.AsyncWaitHandle\.WaitOne\(\$TimeoutMs\)\) \{ throw/);
    expect(probe).toContain('$ssl.ReadTimeout = $TimeoutMs');
    expect(probe).not.toMatch(/\$client\.Connect\(/);
    expect(probe).toMatch(/\$built = \$chain\.Build\(\$leaf\)/);
    expect(probe).toMatch(/if \(-not \$built\) \{\n[^\n]*\n\s*throw "certificate chain is not valid/);
    expect(probe).toMatch(/RemoteCertificateNameMismatch\) \{\s*throw/);
    // 실패는 throw → catch에서 Ok=$false로 돌아가야 설치·상태가 실패로 판정한다.
    expect(probe.indexOf('$result.Ok = $true')).toBeGreaterThan(probe.indexOf('if (-not $built)'));
  });

  it('실패하면 이번 실행이 만든 서비스·방화벽·bin 파일만 되돌리고 CA(data)는 남긴다', () => {
    const b = body();
    const undo = b.slice(indexIn(b, '} catch {\n        Write-Fail $_.Exception.Message'));
    expect(undo).toContain('if ($created.Service)');
    expect(undo).toContain('if ($created.Firewall) { Remove-NetFirewallRule -Group $FirewallGroup');
    expect(undo).not.toMatch(/Remove-Item[^\n]*(\$DataDir|\$CaDir|\$Root\b|\$LogDir)/);
  });
});

describe('install-caddy-host.ps1 -Uninstall / -Status', () => {
  it('Uninstall은 pilot·docker 모드에서만(host는 거부 — 8443이 빈다), 우리 서비스일 때만 지우고, CA(data)·logs는 절대 지우지 않는다', () => {
    const b = fnBody('Invoke-Uninstall');
    expect(b).toMatch(/if \(\$state -and @\('pilot', 'docker'\) -notcontains \[string\]\$state\.mode\) \{\s*throw "[^"]*-Rollback first/);
    expect(b).toMatch(/if \(\$svc -and \$svc\.PathName -notlike "\$ExeDest \*"\) \{\s*throw/);
    expect(b).toContain('foreach ($f in @($ExeDest, $ConfigDest, $ConfigNext, $ConfigPrev, $StateFile, $SnapshotFile, $HostModeFile, $RootCrtPublic)) {');
    expect(b).not.toMatch(/Remove-Item[^\n]*(\$DataDir|\$CaDir|\$LogDir|\$Root\b|-Recurse)/);
    // 중단된 전환(기록 'applied')이 남아 있으면 모드와 상관없이 변경 전에 거부(Codex PR 리뷰 1회차).
    expect(b).toMatch(/if \(\$journal -and \[string\]\$journal\.status -eq 'applied'\) \{\s*throw/);
    expect(indexIn(b, '$journal = Get-HostModeJson')).toBeLessThan(indexIn(b, 'Write-Step'));
  });

  it('Status는 읽기 전용이다(ShouldProcess·변경 명령 없음)', () => {
    const b = fnBody('Invoke-Status');
    expect(b).not.toMatch(/ShouldProcess|Remove-Item|New-Item|Copy-Item|sc\.exe|Invoke-Icacls|Start-Service|Stop-Service|NetFirewallRule -/);
    expect(b).toMatch(/exit 0/);
    expect(b).toMatch(/exit 1/);
  });

  it('Status는 Caddyfile 업스트림이 앱의 실제 게시 포트와 다르면 문제로 보고한다', () => {
    const b = fnBody('Invoke-Status');
    expect(b).toMatch(/if \(\$appPort -eq \[int\]\$state\.upstreamPort\)/);
  });

  it('Status는 앱 게시 규칙 위반(비루프백·없음·복수)을 문제로, Docker 조회 불가만 경고로 본다', () => {
    // Codex PR 리뷰 1회차: 비루프백 게시를 감지해도 경고만 내고 Status: OK였다.
    const b = fnBody('Invoke-Status');
    expect(b).toMatch(/try \{ \$owners = @\(Get-PortOwners\) \} catch \{ Write-Warn/);
    // 게시 규칙 검사는 모든 모드에서(docker 모드도), 업스트림 비교만 docker 모드에서 생략(PR 리뷰 2회차).
    expect(b).toMatch(/if \(\$null -ne \$owners\) \{\s*try \{/);
    expect(b).toContain("if ($mode -eq 'docker') { Write-Ok \"App published on 127.0.0.1:$appPort only");
    expect(b).toMatch(/\$appPort = Get-AppPublishedPort -Owners \$owners[\s\S]*?\} catch \{ Write-Fail \$_\.Exception\.Message; \$problems\+\+ \}/);
  });

  it('JSON 배열은 변수에 먼저 받은 뒤 @()로 감싼다 — 5.1 ConvertFrom-Json은 배열을 파이프라인 객체 하나로 낸다', () => {
    // 관리자 리허설에서 5.1 Status의 리스너 비교가 "TCP TCP TCP ..."로 뭉쳐 나와 찾은 결함.
    expect(CODE).not.toMatch(/@\([^\n]*\|\s*ConvertFrom-Json\s*\)/);
    expect(fnBody('Invoke-Status')).toMatch(/\$parsed = [^\n]*\| ConvertFrom-Json\n\s*\$before = @\(\$parsed\)/);
  });

  it('앱 포트는 compose 라벨·실제 HostIp/HostPort로 찾고, 비루프백 게시면 중단한다(publish= 필터 미사용)', () => {
    const b = fnBody('Get-AppPublishedPort');
    expect(b).toContain("$_.Project -eq $ProjectName -and $_.Service -eq 'app'");
    expect(b).toMatch(/\$_\.HostIp -ne '127\.0\.0\.1'/);
    expect(CODE).not.toMatch(/--filter publish=/);
  });
});

describe('install-caddy-host.ps1 -Cutover / -Rollback / -Reconfigure (PR-3b)', () => {
  const cut = () => fnBody('Invoke-Cutover');
  const rb = () => fnBody('Invoke-Rollback');
  const before = (text, a, b) => expect(indexIn(text, a)).toBeLessThan(indexIn(text, b));

  it('모드 전이: Cutover는 pilot·docker에서, Rollback은 host에서만, Reconfigure는 pilot·host에서', () => {
    expect(cut()).toContain("$inst = Get-TrustedInstall @('pilot', 'docker')");
    expect(rb()).toContain("$inst = Get-TrustedInstall @('host', 'pilot', 'docker')");
    // pilot/docker에서의 Rollback은 중단된 전환(기록 'applied')을 마무리할 때만(Codex PR 리뷰 1회차).
    expect(rb()).toMatch(/if \(-not \$hm -or \[string\]\$hm\.status -ne 'applied'\) \{\s*if \(\$interrupted\) \{ throw/);
    expect(fnBody('Invoke-Reconfigure')).toContain("$inst = Get-TrustedInstall @('pilot', 'host')");
    // 중단된 전환(pilot + 기록 'applied')에서는 시범 포트로 되돌리지 않고 거부(PR 리뷰 2회차).
    expect(fnBody('Invoke-Reconfigure')).toMatch(/if \(\[string\]\$state\.mode -ne 'host' -and \$journal -and \[string\]\$journal\.status -eq 'applied'\) \{\s*throw/);
    const g = fnAny('Get-TrustedInstall');
    expect(g).toMatch(/if \(\$Modes -notcontains \$mode\) \{ throw/);
    // 우리 서비스·잠긴 설치 폴더·설치 때 기록한 caddy.exe 해시와 CA 지문이어야 손댄다.
    for (const s of ['$svc.PathName -notlike "$ExeDest *"', 'Get-ExistingRootProblem -MustExist', 'Get-ReparsePoints $d', '[string]$state.caddyExeSha512', '[string]$state.rootSha256']) {
      expect(g).toContain(s);
    }
  });

  it('미리 보기에 쓰는 compose 기본값이 docker-compose.yml의 기본값과 같다(5.1에서 빈 값은 변수 삭제 — Codex 계획 리뷰 1회차)', () => {
    const compose = read('../docker-compose.yml');
    const https = /\$\{WR_CADDY_HTTPS_BIND:-(\d+)\}:443/.exec(compose)[1];
    const http = /\$\{WR_CADDY_HTTP_BIND:-(\d+)\}:80/.exec(compose)[1];
    expect(SCRIPT).toContain(`$ComposeDefaultBinds = @{ WR_CADDY_HTTPS_BIND = '${https}'; WR_CADDY_HTTP_BIND = '${http}' }`);
    expect(SCRIPT).toContain("$HostBinds           = @{ WR_CADDY_HTTPS_BIND = '127.0.0.1:18443'; WR_CADDY_HTTP_BIND = '127.0.0.1:18080' }");
    const g = fnAny('Get-ComposeConfig');
    expect(g).toMatch(/IsNullOrEmpty\(\[string\]\$Overrides\[\$k\]\)\) \{ throw/);
    // 셸 변수는 finally에서 지운다. PowerShell 7은 $null을 ''로 넘겨 빈 변수가 남으므로 [NullString]::Value.
    // Set-Item/Remove-Item Env:는 -WhatIf를 따르므로 쓰지 않는다.
    expect(g).toMatch(/\} finally \{\s*foreach \(\$k in @\(\$Overrides\.Keys\)\) \{ \[Environment\]::SetEnvironmentVariable\(\$k, \[NullString\]::Value, 'Process'\) \}/);
    expect(CODE).not.toMatch(/(Set|Remove)-Item\s+(-LiteralPath\s+|-Path\s+)?["']?Env:(?!<)|SetEnvironmentVariable\([^\n]*\$null/);
    expect(g).toContain("@('config', '--format', 'json')");
  });

  it('셸 변수 검사는 env 키 + compose가 참조하는 변수 전체(WR_DOMAIN 등)이고, 동작 맨 앞에서 한다(Codex 계획 리뷰 2회차)', () => {
    const names = fnAny('Get-ComposeVariableNames');
    expect(names).toContain("'\\$\\{([A-Za-z_][A-Za-z0-9_]*)'");
    expect(names).toContain('[System.IO.File]::ReadAllLines($EnvFile)');
    expect(names).toContain('[System.StringComparer]::OrdinalIgnoreCase');
    for (const b of [cut(), rb()]) before(b, 'Assert-NoShellOverride', 'Get-ComposeConfig');
    expect(fnBody('Invoke-Status')).toContain('$shellVars = @(Get-ShellOverrides)');
  });

  it('대상 구성 검사: 앱은 127.0.0.1, caddy 게시, CA 볼륨 이름 = 설치 때 볼륨, caddy WR_DOMAIN = env·설치 도메인', () => {
    const a = fnAny('Assert-TargetConfig');
    expect(a).toContain("-ne '127.0.0.1') { throw");
    expect(a).toContain("if ($volName -ne [string]$State.caVolume) {");
    expect(a).toContain("(Get-JsonProp (Get-JsonProp $Config 'volumes') ([string](Get-JsonProp $dataMount[0] 'source'))) 'name'");
    expect(a).toContain('if ($d -ne $Domain -or $d -ne [string]$State.domain) { throw');
  });

  it('Cutover 순서: 검사·대상 구성·validate → (WhatIf 끝) → 서비스 정지 → host-mode.json → env → caddy 재생성 → 시작, 실패하면 자동 복귀', () => {
    const b = cut();
    before(b, 'Assert-ComposeMatchesContainer $container', 'Stop-HostService');
    before(b, 'Assert-TargetConfig (Get-ComposeConfig $HostBinds) $HostBinds', 'if ($whatIf) {');
    before(b, 'if ($whatIf) {', 'Write-ValidatedConfig $ConfigNext $config');
    before(b, 'Write-ValidatedConfig $ConfigNext $config', 'Stop-HostService');
    // 기록(journal)이 서비스 정지보다 먼저: 창이 닫혀 중단돼도 'applied'가 남아 Uninstall은 거부, Rollback이 마무리(Codex PR 리뷰 1회차).
    before(b, 'Write-TextFile $HostModeFile', 'Stop-HostService');
    before(b, 'Stop-HostService', "Write-EnvKeys $EnvFile $changes 'cutover'");
    before(b, "Write-EnvKeys $EnvFile $changes 'cutover'", '$envEdited = $true');
    before(b, '$envEdited = $true', 'Invoke-ComposeUpCaddy');
    before(b, 'Invoke-ComposeUpCaddy', 'Move-Item -LiteralPath $ConfigNext -Destination $ConfigDest');
    before(b, "Set-ServiceStart 'auto'", 'Start-Service -Name $ServiceName');
    expect(b).toMatch(/\} catch \{[\s\S]*if \(Restore-DockerMode \$state \$domain \$envEdited\)/);
    // 이전 전환이 중간에 끊긴 흔적(env에 이미 host 값, host-mode.json applied)이 있으면 덮어쓰지 않는다.
    expect(b).toMatch(/\$current\[\$k\]\.Value -eq \$HostBinds\[\$k\]\) \{\s*throw/);
    expect(b).toMatch(/\[string\]\$hm\.status -eq 'applied'\) \{\s*throw/);
    // 기록: 모드 키는 revert, WR_APP_PORT는 retain(롤백 때 되돌리지 않음).
    expect(b).toContain("key = $k; action = 'revert'");
    expect(b).toContain("key = 'WR_APP_PORT'; action = 'retain'");
  });

  it('자동 복귀: 서비스 정지+disabled → (env를 고쳤으면) 모드 키만 복원 → caddy 재생성 → 8443을 Docker가 같은 CA로 응답', () => {
    const r = fnAny('Restore-DockerMode');
    before(r, 'Stop-Service -Name $ServiceName -Force', "Set-ServiceStart 'disabled'");
    before(r, "Set-ServiceStart 'disabled'", 'if ($EnvEdited) {');
    before(r, 'Undo-EnvModeKeys', 'Invoke-ComposeUpCaddy');
    before(r, 'Invoke-ComposeUpCaddy', 'Wait-DockerHttps $Domain ([string]$State.rootSha256)');
    expect(r).toContain('Could not finish returning to the Docker Caddy. Run -Rollback');
    // 기록은 Docker 응답·mode=docker 뒤에 닫는다: env를 고치기 전 실패면 'aborted'(안 닫으면 재전환이 영원히 막힘, PR 리뷰 1회차),
    // 그 전에 실패하면 'applied'로 남아 -Rollback으로 이어서 할 수 있다(PR 리뷰 2회차).
    expect(r).toContain("if ($EnvEdited) { Close-HostModeJournal 'reverted' } else { Close-HostModeJournal 'aborted' }");
    before(r, "Update-JsonFile $StateFile @{ mode = 'docker'", 'Close-HostModeJournal');
    before(r, 'Wait-DockerHttps', 'Close-HostModeJournal');
    expect(fnBody('Undo-EnvModeKeys')).not.toMatch(/Update-JsonFile|Close-HostModeJournal/);
  });

  it('Rollback: env 값이 전환 때 넣은 값과 같을 때만, 서비스를 멈추기 전에 대상 구성을 검사하고, 서비스는 disabled', () => {
    const b = rb();
    expect(b).toContain('$atNew = ($current[$k].Exists -and $current[$k].Value -eq [string]$e.newValue)');
    // 이전 값 그대로인 키도 허용: 중단된 전환, 또는 env를 복원한 뒤 실패한 롤백의 재실행(PR 리뷰 2회차). 그 밖의 값은 손으로 바꾼 것.
    expect(b).toContain('$atPrevious = ($current[$k].Exists -eq [bool]$e.existedBefore -and ');
    before(b, "Update-JsonFile $StateFile @{ mode = 'docker'", "Close-HostModeJournal 'reverted'");
    expect(b).toMatch(/if \(-not \$atNew -and -not \$atPrevious\) \{\s*throw/);
    // 중단된 전환에서는 Docker가 아직 8443을 쥐고 있을 수 있다: 제3 프로그램만 거부하고, 기다릴 때도 Docker는 제외.
    expect(b).toContain('$_.Pid -ne $svcPid -and $_.Process -notmatch $DockerProcessPattern');
    expect(b).toContain('Wait-Until { Test-NoHostListener } 30');
    expect(b).toContain('if ($e.existedBefore) { $targetBinds[$k] = [string]$e.previousValue } else { $targetBinds[$k] = $ComposeDefaultBinds[$k] }');
    before(b, 'Assert-TargetConfig (Get-ComposeConfig $targetBinds) $targetBinds', 'Stop-HostService');
    before(b, 'if ($whatIf) {', 'Stop-HostService');
    before(b, 'Stop-HostService', "Set-ServiceStart 'disabled'");
    before(b, "Set-ServiceStart 'disabled'", 'Undo-EnvModeKeys');
    before(b, 'Undo-EnvModeKeys', 'Invoke-ComposeUpCaddy');
    before(b, 'Invoke-ComposeUpCaddy', 'Wait-DockerHttps $domain');
  });

  it('env 되돌리기는 revert 항목만 키 단위로 — 백업을 통째로 되돌리는 코드가 없다(WR_VERSION·비밀번호가 되돌아감)', () => {
    const u = fnBody('Undo-EnvModeKeys');
    expect(u).toContain("if ([string]$e.action -ne 'revert') { continue }");
    expect(u).toContain('if ($e.existedBefore) { $changes[[string]$e.key] = [string]$e.previousLine } else { $changes[[string]$e.key] = $null }');
    expect(CODE).not.toMatch(/(Copy|Move)-Item[^\n]*before-/);
    expect(CODE.match(/Write-EnvKeys \$EnvFile/g)).toHaveLength(2); // Cutover(모드 키)·Undo-EnvModeKeys(revert 항목)
  });

  it('Write-EnvKeys: 임시 파일은 env의 ACL로 독점 생성하고, 같은 핸들로 ACL 확인·기록한다(Codex 계획 리뷰 2~4회차)', () => {
    const w = fnAny('Write-EnvKeys');
    expect(w).toContain("[System.Security.AccessControl.FileSystemRights]'Write, ReadPermissions'");
    expect(w).toContain('[System.IO.FileSystemAclExtensions]::Create((New-Object System.IO.FileInfo $tmp), [System.IO.FileMode]::CreateNew, $rights,');
    expect(w).toContain('New-Object System.IO.FileStream ($tmp, [System.IO.FileMode]::CreateNew, $rights, [System.IO.FileShare]::None');
    expect(w.match(/\[System\.IO\.FileShare\]::None/g)).toHaveLength(2);
    expect(w).toContain("$sec.SetSecurityDescriptorSddlForm($origAcl.GetSecurityDescriptorSddlForm('Access'), 'Access')");
    before(w, '$tmpAcl = $fs.GetAccessControl()', '$fs.Write($body');
    before(w, '$tmpAcl = [System.IO.FileSystemAclExtensions]::GetAccessControl($fs)', '$fs.Write($body');
    before(w, 'Get-ForeignAccess $tmp $ReadRights $readers -Acl $tmpAcl', '$fs.Write($body');
    expect(w).not.toMatch(/Set-Acl|SetAccessControl/);
    expect(w).toMatch(/\} finally \{\s*if \(\$fs\) \{ \$fs\.Dispose\(\) \}\s*if \(Test-Path -LiteralPath \$tmp\) \{ Remove-Item -LiteralPath \$tmp/);
    // 같은 키가 여러 줄이면 편집하지 않는다.
    expect(w).toMatch(/if \(\$handled\.ContainsKey\(\$key\)\) \{ throw/);
    // 줄마다 원래 줄바꿈을 그대로 쓴다(관리자 리허설: LF 파일에 CRLF 줄 하나가 붙자 파일 전체가 CRLF로 바뀌었다).
    expect(w).toContain('if ($null -eq $key) { [void]$sb.Append($l).Append($doc.Endings[$i]); continue }');
    expect(w).toContain('[void]$sb.Append([string]$Changes[$key]).Append($doc.Endings[$i])');
    expect(fnAny('Read-EnvDocument')).toContain('$endings.Add($m.Groups[2].Value)');
  });

  it('변경 동작은 머신 범위 Mutex로 한 번에 하나만 — 다른 창의 -Cutover가 -Uninstall의 검사와 삭제 사이에 끼지 못한다(PR 리뷰 3회차)', () => {
    const lock = indexIn(SCRIPT, "$RunLock = New-Object System.Threading.Mutex ($false, 'Global\\wr-evaluation-caddy-host')");
    expect(lock).toBeLessThan(indexIn(SCRIPT, "        'Uninstall'   { Invoke-Uninstall }"));
    expect(SCRIPT).toContain("if ($PSCmdlet.ParameterSetName -ne 'Status' -and -not $WhatIfPreference -and (Test-Admin)) {");
    expect(SCRIPT).toMatch(/if \(-not \$RunLockOwned\) \{\s*\$RunLock\.Dispose\(\)[\s\S]{0,300}?exit 1/);
    // 운영자 콘솔에서 실행하면 exit는 스크립트만 끝내고 프로세스는 남는다 — finally에서 해제(PR 리뷰 4회차, 5.1·7 재현).
    expect(SCRIPT).toMatch(/\} finally \{\s*if \(\$RunLockOwned\) \{ \$RunLock\.ReleaseMutex\(\) \}\s*if \(\$RunLock\) \{ \$RunLock\.Dispose\(\) \}\s*\}\s*$/);
    expect(indexIn(SCRIPT, "$RunLockOwned = $false")).toBeLessThan(indexIn(SCRIPT, "            'Cutover'     { Invoke-Cutover }"));
    // 5.1·7 모두 AbandonedMutexException을 MethodInvocationException으로 감싼다(실측) — 타입 지정 catch로는 못 잡는다.
    expect(SCRIPT).toContain('$_.Exception.InnerException -is [System.Threading.AbandonedMutexException]');
    expect(CODE).not.toMatch(/catch \[System\.Threading\.AbandonedMutexException\]/);
  });

  it('실행 중인 caddy 컨테이너와 같은 폴더·compose 파일·env 파일로만 재생성한다', () => {
    const a = fnAny('Assert-ComposeMatchesContainer');
    // compose는 뒤 파일이 앞 파일을 덮어쓰므로 순서까지 같아야 한다(정렬 금지, Codex PR 리뷰 1회차).
    expect(a).not.toMatch(/Sort-Object/);
    for (const l of ['com.docker.compose.project.working_dir', 'com.docker.compose.project.config_files', 'com.docker.compose.project.environment_file']) expect(a).toContain(l);
    expect(a).toMatch(/if \(\(& \$norm \$wd\) -ne \(& \$norm \$ComposeDir\)\) \{\s*throw/);
    expect(a).toMatch(/if \(\(\$have -join '\|'\) -ne \(\$want -join '\|'\)\) \{\s*throw/);
    expect(a).toMatch(/if \(\$envLabel -and \(& \$norm \$envLabel\) -ne \(& \$norm \$EnvFile\)\) \{\s*throw/);
    expect(cut()).toMatch(/if \(-not \$container\) \{ throw/);
  });

  it('Status: docker 모드에서 시작 유형이 Disabled가 아니면 문제(재부팅 때 8443 경합), host 모드는 env 모드 키·Docker Caddy 루프백 확인', () => {
    const s = fnBody('Invoke-Status');
    expect(s).toMatch(/if \(\$svc\.StartMode -ne 'Disabled'\) \{ Write-Fail [^\n]*\$problems\+\+ \}/);
    expect(s).toMatch(/if \(\$svc\.StartMode -ne 'Auto'\) \{ Write-Fail [^\n]*\$problems\+\+ \}/);
    expect(s).toContain("@($dock | Where-Object { $_.HostIp -ne '127.0.0.1' }).Count -eq 0");
    expect(s).toContain('$bad = @($ModeKeys | Where-Object { -not $envKeys[$_].Exists -or $envKeys[$_].Value -ne $HostBinds[$_] })');
    expect(s).toContain('$bad = @($ModeKeys | Where-Object { $envKeys[$_].Exists -and $envKeys[$_].Value -eq $HostBinds[$_] })');
    // PowerShell 변수는 대소문자를 구분하지 않는다: 지역 변수가 $ModeKeys를 가리면 안 된다.
    expect(CODE).not.toMatch(/\$modeKeys\b/); // 대소문자 구분 검색: 소문자로 쓴 지역 변수만 잡는다
  });
});

describe('export-offline-package.ps1 — caddy-host/에 설치 스크립트·템플릿 포함', () => {
  it('호스트 Caddy를 넣을 때 install-caddy-host.ps1과 Caddyfile.host.template도 같은 폴더에 복사한다', () => {
    const at = indexIn(EXPORT, 'if ($caddyPin) {\n    $caddyHostDest');
    const block = EXPORT.slice(at, EXPORT.indexOf('\n}\n', at));
    expect(block).toContain('Copy-Required (Join-Path $RepoRoot "scripts\\install-caddy-host.ps1") $caddyHostDest');
    expect(block).toContain('Copy-Required (Join-Path $RepoRoot "caddy\\Caddyfile.host.template") $caddyHostDest');
  });

  it('스크립트는 패키지 레이아웃(caddy-host\\caddy.exe)이면 패키지 루트의 release-manifest.json으로 검증한다', () => {
    expect(SCRIPT).toContain("$packageExe = Join-Path $ScriptDir 'caddy.exe'");
    expect(SCRIPT).toContain("$manifestPath = Join-Path $PackageRoot 'release-manifest.json'");
  });
});
