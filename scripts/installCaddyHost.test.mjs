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

  it('이 버전은 시범 포트만 — 8443/8080은 거부하고 .env·compose·컨테이너는 바꾸지 않는다', () => {
    expect(SCRIPT).toContain('$ReservedPorts  = @(8443, 8080)');
    expect(SCRIPT).toMatch(/if \(\$ReservedPorts -contains \$p\) \{ throw/);
    expect(SCRIPT).toMatch(/\[int\]\$HttpsPort\s*=\s*9443/);
    expect(SCRIPT).toMatch(/\[int\]\$HttpPort\s*=\s*9080/);
    expect(CODE).not.toMatch(/docker compose[^\n]*\b(up|down|stop|restart|rm)\b/);
    expect(CODE).not.toMatch(/docker (stop|restart|kill|volume rm|rm -f)/);
    expect(CODE).not.toMatch(/(Set|Add)-Content[^\n]*\$EnvFile/);
    expect(CODE).not.toMatch(/WriteAllText\(\$EnvFile/);
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

  it('설치·제거는 관리자 권한을 요구한다(-WhatIf 제외)', () => {
    for (const fn of ['Invoke-Install', 'Invoke-Uninstall']) {
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
  it('Uninstall은 시범 모드에서만, 우리 서비스일 때만 지우고, CA(data)·logs는 절대 지우지 않는다', () => {
    const b = fnBody('Invoke-Uninstall');
    expect(b).toMatch(/if \(\$state -and \[string\]\$state\.mode -ne 'pilot'\) \{\s*throw/);
    expect(b).toMatch(/if \(\$svc -and \$svc\.PathName -notlike "\$ExeDest \*"\) \{\s*throw/);
    expect(b).toContain('foreach ($f in @($ExeDest, $ConfigDest, $StateFile, $SnapshotFile, $RootCrtPublic)) {');
    expect(b).not.toMatch(/Remove-Item[^\n]*(\$DataDir|\$CaDir|\$LogDir|\$Root\b|-Recurse)/);
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
