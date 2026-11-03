import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// scripts/verify-stack.ps1 은 PowerShell + Docker 라 단위 테스트가 어렵다. 실제 동작은 7.1.4 패키지로 끝까지 실행해 확인했다
// (up → 접속·/updates 응답·로그인 → down → purge → 새 볼륨 up → down → purge). 이 테스트는 그때 확인한 **안전 불변식**이
// 의도 없이 바뀌는 것을 막는다 — 운영/개발 프로젝트를 건드리지 않는다, 실제 비밀값을 읽지 않는다, 볼륨을 함부로 지우지 않는다,
// 시작 순서(backup-monitor 먼저)와 이미지 대조가 compose up 보다 앞선다. 메시지 문구가 아니라 조건·순서를 본다.
const SCRIPT = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'verify-stack.ps1'), 'utf8')
  .replace(/\r\n/g, '\n');

const indexOfOrFail = (needle, from = 0) => {
  const i = SCRIPT.indexOf(needle, from);
  if (i < 0) throw new Error(`verify-stack.ps1에서 찾지 못했습니다: ${needle}`);
  return i;
};
// 도움말 블록(<# ... #>)과 줄 전체 주석을 뺀 코드.
const CODE_NO_HELP = () => SCRIPT.replace(/<#[\s\S]*?#>/, '').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const fnBody = (name) => {
  const start = indexOfOrFail(`function ${name}`);
  const next = SCRIPT.indexOf('\nfunction ', start + 1);
  return SCRIPT.slice(start, next < 0 ? undefined : next);
};

describe('verify-stack.ps1 — 다른 스택을 건드리지 않는다', () => {
  it('PowerShell 7 이상을 요구한다', () => {
    expect(SCRIPT.startsWith('#Requires -Version 7')).toBe(true);
  });

  it('프로젝트 이름은 wr-verify 로 고정이고 파라미터로 열려 있지 않다', () => {
    const params = SCRIPT.match(/\nparam\(([\s\S]*?)\n\)/)?.[1] ?? '';
    expect(params).not.toMatch(/ProjectName/i);
    expect(SCRIPT).toMatch(/^\$ProjectName\s*=\s*'wr-verify'/m);
  });

  it('모든 compose 호출은 Invoke-Compose 를 거치고, 그 안에서 프로젝트 이름이 wr-verify 가 아니면 중단한다', () => {
    const fn = fnBody('Invoke-Compose');
    expect(fn).toMatch(/if\s*\(\$ProjectName\s+-ne\s+'wr-verify'\)\s*\{\s*throw/);
    // Invoke-Compose 밖에서 명령 위치에 'docker compose' 를 직접 부르는 곳은 버전 확인(프로젝트와 무관)뿐이다.
    // (오류 메시지 문자열 안의 'docker compose' 는 호출이 아니므로 줄 시작 위치만 본다.)
    const rest = SCRIPT.replace(fn, '');
    const direct = rest.split('\n').filter((l) => /^\s*(&\s*)?docker\s+compose\b/.test(l));
    for (const line of direct) expect(line).toMatch(/docker compose version/);
    // 분할 인자(@script:ComposeBase)로 docker 를 부르는 곳은 Invoke-Compose 하나뿐이다.
    expect(rest).not.toMatch(/&\s*docker\s+@script:ComposeBase/);
    expect(fn).toMatch(/&\s*docker\s+@script:ComposeBase/);
  });

  it('compose 기본 인자의 -p 는 $ProjectName 이다', () => {
    const fn = fnBody('Get-ComposeBase');
    expect(fn).toMatch(/'-p',\s*\$ProjectName/);
  });

  it('실제 .env.production 을 읽지 않는다 — 환경 파일은 release\\.verify-stack 아래 시험 전용이다', () => {
    expect(SCRIPT).toMatch(/\$EnvFile\s*=\s*Join-Path \$WorkDir\s+'wr-verify\.env'/);
    expect(SCRIPT).toMatch(/\$WorkDir\s*=\s*Join-Path \$RepoRoot 'release\\\.verify-stack'/);
    const reads = SCRIPT.split('\n').filter((l) => /Get-Content|ReadAllText|--env-file/.test(l) && /\.env\.production/.test(l));
    expect(reads).toEqual([]);
  });

  it('비밀값은 무작위로 만들고 고정·changeme 값을 쓰지 않는다', () => {
    expect(SCRIPT).toContain('RandomNumberGenerator');
    for (const key of ['POSTGRES_PASSWORD', 'AUDIT_DB_PASSWORD', 'ACCESS_TOKEN_SECRET', 'REFRESH_TOKEN_SECRET']) {
      expect(SCRIPT).toMatch(new RegExp(`${key}=\\$\\(New-HexSecret\\)`));
    }
    expect(SCRIPT.toLowerCase()).not.toContain('changeme');
  });

  it('환경 파일 템플릿은 통계 워크벤치를 켜고(꺼 두면 설치본에 버튼이 안 뜬다) 영상 분석은 운영 기본값(꺼짐)으로 둔다', () => {
    expect(SCRIPT).toMatch(/^STATS_WORKBENCH_ENABLED=true$/m);
    expect(SCRIPT).toMatch(/^#VIDEO_ANALYSIS_ENABLED=true$/m);
    expect(SCRIPT).not.toMatch(/^VIDEO_ANALYSIS_ENABLED=true$/m);
  });
});

describe('verify-stack.ps1 — 볼륨', () => {
  it('Caddy CA 볼륨은 external 로 재사용하고(-FreshCa 가 아닐 때만), 이름은 기존 볼륨이다', () => {
    const fn = fnBody('Write-OverrideFile');
    expect(fn).toMatch(/if\s*\(-not \$FreshCa\)\s*\{[\s\S]*?external: true[\s\S]*?name: \$CaVolumeName/);
    expect(SCRIPT).toMatch(/^\$CaVolumeName\s*=\s*'wr-evaluation-unified_caddy_data'/m);
  });

  it('모든 서비스의 재시작 정책을 no 로 덮어쓴다 — PC 재부팅 시 저절로 8443 을 잡지 않는다', () => {
    const fn = fnBody('Write-OverrideFile');
    for (const svc of ['postgres', 'backup-monitor', 'partition', 'app', 'caddy']) {
      expect(fn).toMatch(new RegExp(`${svc}:\\s*\\{ restart: "no" \\}`));
    }
  });

  it('down 은 볼륨을 지우지 않는다(-v 없음)', () => {
    const fn = fnBody('Invoke-Down');
    expect(fn).toMatch(/Invoke-Compose @\('down', '--remove-orphans'\)/);
    expect(fn).not.toMatch(/'-v'/);
  });

  it('볼륨 삭제(-v)는 purge 에서만, 확인 질문(YES) 또는 -Force 뒤에만 한다', () => {
    const withV = SCRIPT.split('\n').filter((l) => /'down',\s*'-v'/.test(l));
    expect(withV).toHaveLength(1);
    const fn = fnBody('Invoke-Purge');
    expect(fn).toContain("'down', '-v'");
    const guard = fn.indexOf('if (-not $Force)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(fn.indexOf("-ne 'YES'")).toBeGreaterThan(guard);
    expect(fn.indexOf("'down', '-v'")).toBeGreaterThan(fn.indexOf("-ne 'YES'"));
  });

  it('purge 뒤에 공유 Caddy CA 볼륨이 실제로 남았는지 확인한다', () => {
    const fn = fnBody('Invoke-Purge');
    expect(fn).toMatch(/\$_\s+-eq\s+\$CaVolumeName/);
  });
});

describe('verify-stack.ps1 — 기동 순서·검증', () => {
  const up = () => fnBody('Invoke-Up');

  it('이미지 ID 대조 → compose 설정 검증 → 포트 점검 → 기동 순서다', () => {
    const body = up();
    const images = body.indexOf('Assert-Images');
    const config = body.indexOf("'config', '--quiet'");
    const ports = body.indexOf('Assert-PortsFree');
    const start = body.indexOf("'up', '-d', 'backup-monitor'");
    expect(images).toBeGreaterThanOrEqual(0);
    expect(images).toBeLessThan(config);
    expect(config).toBeLessThan(ports);
    expect(ports).toBeLessThan(start);
  });

  it('이미지 ID 가 패키지 매니페스트와 다르면 중단한다', () => {
    const fn = fnBody('Assert-Images');
    expect(fn).toMatch(/\$id\.Trim\(\)\s+-ne\s+\$img\.imageId/);
    expect(up()).toMatch(/if\s*\(\$bad\.Count -gt 0\)\s*\{[\s\S]*?Stop-WithError/);
  });

  it('backup-monitor 를 나머지 서비스보다 먼저 올린다(빈 볼륨에서 app 이 /backups/_alerts 를 마운트하려면 필요)', () => {
    const body = up();
    const first = body.indexOf("'up', '-d', 'backup-monitor'");
    const all = body.indexOf("Invoke-Compose @('up', '-d')");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(all).toBeGreaterThan(first);
  });

  it('다른 컨테이너가 8443/8080/앱 포트를 쓰고 있으면 건드리지 않고 중단한다', () => {
    const fn = fnBody('Assert-PortsFree');
    const each = fnBody('Assert-PortForThisStack');
    // docker 모드: 8443/8080, 모든 모드: 앱 포트 — 이 프로젝트 컨테이너만 허용.
    expect(fn).toMatch(/foreach \(\$port in \$HttpsPort, \$HttpPort\) \{ Assert-PortForThisStack \$port \$owners \}/);
    expect(fn).toContain('Assert-PortForThisStack (Get-AppPort) $owners');
    expect(each).toMatch(/\$_\.Project -ne \$ProjectName/);
    expect(each).toMatch(/if\s*\(\$others\.Count -gt 0\)\s*\{\s*Stop-WithError/);
    for (const f of [fn, each]) expect(f).not.toMatch(/Stop-Process|docker (stop|rm|kill)/);
  });

  it('포트 점유자는 실제 HostPort 매핑으로 찾는다 — 의미가 버전마다 다를 수 있는 publish 필터를 쓰지 않는다', () => {
    expect(SCRIPT).not.toMatch(/--filter\s+"?publish=/);
    const fn = fnBody('Get-PortOwners');
    expect(fn).toMatch(/docker inspect @ids/);
    expect(fn).toMatch(/NetworkSettings\.Ports/);
    expect(fn).toMatch(/HostPort = \[int\]\$b\.HostPort/);
    expect(fn).toMatch(/com\.docker\.compose\.project/);
  });

  it('앱 루프백 포트는 13001 이고(개발 서버 3001 회피) 새 환경 파일·기존 환경 파일 모두에 들어간다', () => {
    expect(SCRIPT).toMatch(/^\$AppPort\s*=\s*13001\b/m);
    const fn = fnBody('Initialize-EnvFile');
    expect(fn).toMatch(/^WR_APP_PORT=\$AppPort$/m);
    expect(fn).toMatch(/if \(\$cur -notmatch '\(\?m\)\^WR_APP_PORT='\)\s*\{[\s\S]*?WR_APP_PORT=\$AppPort/);
  });

  it('기동 전에 셸 덮어쓰기 변수를 거부하고, 해석된 설정의 app 게시가 127.0.0.1·환경 파일 포트인지 확인한다', () => {
    const guard = fnBody('Assert-NoShellOverride');
    expect(guard).toMatch(/Test-Path "env:\$_"/);
    expect(SCRIPT).toMatch(/\$ShellOverrideKeys = @\('WR_APP_PORT', 'WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND', 'WR_DOMAIN'\)/);
    const check = fnBody('Assert-AppLoopbackOnly');
    expect(check).toMatch(/Invoke-Compose @\('config', '--format', 'json'\)/);
    expect(check).toMatch(/if \(\$hostIp -ne '127\.0\.0\.1'\)\s*\{\s*Stop-WithError/);
    expect(check).toMatch(/-ne "\$want"\)\s*\{\s*Stop-WithError/);
    const body = up();
    const shell = body.indexOf('Assert-NoShellOverride');
    const config = body.indexOf("'config', '--quiet'");
    const loop = body.indexOf('Assert-AppLoopbackOnly');
    const ports = body.indexOf('Assert-PortsFree');
    const start = body.indexOf("'up', '-d', 'backup-monitor'");
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(shell).toBeLessThan(config);
    expect(config).toBeLessThan(loop);
    expect(loop).toBeLessThan(ports);
    expect(ports).toBeLessThan(start);
  });

  it('만료된 CA 볼륨 인증서(NotTimeValid)는 Caddy 를 단 한 번만 재시작해 해결한다', () => {
    const fn = fnBody('Wait-Https');
    expect(fn).toMatch(/if\s*\(-not \$HostMode -and -not \$restarted -and \$p\.Error -match 'NotTimeValid'\)/);
    expect(fn).toMatch(/Invoke-Compose @\('restart', 'caddy'\)/);
    expect(fn).toMatch(/\$restarted = \$true/);
    // host 모드에서는 8443 이 caddy.exe 라 Docker caddy 재시작은 소용없다 — 안내만 하고 돌아온다(재시작 전에 return).
    const host = fn.indexOf("if ($HostMode -and $p.Error -match 'NotTimeValid')");
    expect(host).toBeGreaterThanOrEqual(0);
    expect(host).toBeLessThan(fn.indexOf("Invoke-Compose @('restart', 'caddy')"));
    expect(up()).toContain('Wait-Https 120 $hc.Host');
  });

  it('감사 계정 비밀번호는 시험 환경 파일의 값으로 동기화한다(고정 문자열 아님)', () => {
    expect(up()).toMatch(/\$auditPw = Get-EnvValue 'AUDIT_DB_PASSWORD'/);
    expect(up()).toContain("ALTER ROLE wr_audit_reader PASSWORD '$auditPw'");
  });

  it('설치본 실행 시 WR_INTRANET_URL 을 비우고(기본 8443 접속) 끝나면 원래 값으로 되돌린다', () => {
    const fn = fnBody('Start-InstalledShell');
    const clear = fn.indexOf('$env:WR_INTRANET_URL = $null');
    const start = fn.indexOf('Start-Process');
    const restore = fn.indexOf('$env:WR_INTRANET_URL = $prev');
    expect(clear).toBeGreaterThanOrEqual(0);
    expect(clear).toBeLessThan(start);
    expect(restore).toBeGreaterThan(start);
  });
});

describe('verify-stack.ps1 — 호스트 Caddy(릴리스 B PR-4)', () => {
  // 비관리자 실측(2026-11-03, docker 모드 검증 스택): up·status 회귀 없음, accept 는 'host 모드 아님'으로 거부,
  // 환경 파일에만 host 값을 넣으면 status 는 경고·up 은 compose 기동 전에 중단.
  // 관리자 리허설(사용자 실행, 2026-11-03): 시범 설치 → 전환 → host 모드 up(8443 = wr-caddy 로 인식, 오인 없음) → accept PASS 3종
  // (감사 IP 루프백 127.0.0.1·LAN 주소 그대로, Docker 경로는 브리지 게이트웨이 / 루프백 5번째에 429 직후 LAN 401 / 8 KiB 200,
  // 16 KiB 부터는 앱(Node)이 431) → status·down 경고(스택이 꺼진 동안 8443 은 502)·up → 롤백 → docker 모드 up → 제거.
  // 헤더 한도 실측: caddy.exe 2.11.7 단독은 17 KiB 통과·20 KiB 431 — 앱의 16 KiB 보다 넉넉해 새로 막히는 요청은 없다.
  // a 가 b 보다 앞에 있어야 한다 — 둘 다 없으면 실패(indexOf 의 -1 이 '앞'으로 통과하지 않게).
  const before = (text, a, b) => {
    const i = text.indexOf(a);
    const j = text.indexOf(b);
    if (i < 0) throw new Error(`찾지 못했습니다: ${a}`);
    if (j < 0) throw new Error(`찾지 못했습니다: ${b}`);
    expect(i).toBeLessThan(j);
  };
  it('host 모드 = 설치 기록(mode host·project wr-verify·기록 applied) + 우리 서비스 실행 중 + 환경 파일 두 키가 모두 맞을 때만', () => {
    const fn = fnBody('Get-HostCaddyMode');
    expect(fn).toContain("if ($mine -and $mode -eq 'host') {");
    expect(fn).toContain("$journalApplied = [bool]($journal -and [string]$journal.status -eq 'applied')");
    expect(fn).toContain('$envHost = ($envHttps -eq $HostHttpsBind -and $envHttp -eq $HostHttpBind)');
    expect(fn).toContain('$svcOurs = [bool]($svc -and $svc.PathName -like "$HostCaddyExe *")');
    expect(fn).toContain('$isHost = ($problems.Count -eq 0)');
    // 세 출처 가운데 하나라도 어긋나면 문제로 남긴다.
    expect(fn).toMatch(/if \(-not \$envHost\) \{ \$problems \+= /);
    expect(fn).toMatch(/if \(-not \$journalApplied\) \{ \$problems \+= /);
    expect(fn).toMatch(/if \(\$svcPid -eq 0\) \{ \$problems \+= /);
    expect(fn).toMatch(/if \(\$envAnyHost\) \{ \$problems \+= /);
    // 정상 host 모드의 'applied' 는 정상(Codex 계획 리뷰 1회차) — 어긋남은 host 가 아닌데 applied 인 경우뿐.
    expect(fn).toMatch(/if \(\$mine -and \$journalApplied\) \{ \$problems \+= /);
    expect(SCRIPT).toContain("$HostHttpsBind  = '127.0.0.1:18443'");
    expect(SCRIPT).toContain("$HostHttpBind   = '127.0.0.1:18080'");
  });

  it('어긋난 상태면 up·accept 는 compose 기동 전에 멈추고, status·down·purge 는 알려만 준다', () => {
    const body = fnBody('Invoke-Up');
    before(body, 'Stop-OnHostCaddyProblems $hc', "'up', '-d', 'backup-monitor'");
    expect(fnBody('Invoke-Accept')).toContain('Stop-OnHostCaddyProblems $hc');
    expect(fnBody('Invoke-Status')).not.toContain('Stop-OnHostCaddyProblems');
    expect(fnBody('Invoke-Down')).toContain('Write-HostModeNotice');
    expect(fnBody('Invoke-Purge')).toContain('Write-HostModeNotice');
  });

  it('host 모드 포트 점검: 8443/8080 은 wr-caddy 프로세스만(컨테이너 게시 없음), 18443/18080 은 이 프로젝트만', () => {
    const fn = fnBody('Assert-PortsFree');
    expect(fn).toMatch(/if \(\$pub\.Count -gt 0\) \{ Stop-WithError "host 모드인데 컨테이너가/);
    expect(fn).toMatch(/if \(-not \$l -or \$l\.Pid -ne \$Hc\.ServicePid\) \{ Stop-WithError/);
    expect(fn).toContain("foreach ($bind in $HostHttpsBind, $HostHttpBind) { Assert-PortForThisStack");
    // docker 모드에서 wr-caddy 가 8443 을 쥐었으면 그렇게 알려 준다(예전엔 '프로세스가 쓰고 있다'로만 보였다).
    expect(fnBody('Assert-PortForThisStack')).toMatch(/\[int\]\$svc\.ProcessId -eq \$l\.Pid\) \{[\s\S]*?Stop-WithError ":\$Port 를 호스트 Caddy 서비스 wr-caddy/);
    const pub = fnBody('Assert-CaddyPublish');
    expect(pub).toContain('@("127.0.0.1|18080|80", "127.0.0.1|18443|443")');
    before(fnBody('Invoke-Up'), 'Assert-CaddyPublish $hc', "'up', '-d', 'backup-monitor'");
  });

  it('관리자 작업(설치·전환·롤백·서비스 제어)을 하지 않는다 — 안내만 한다', () => {
    expect(CODE_NO_HELP()).not.toMatch(/sc\.exe|Start-Service|Stop-Service|Restart-Service -|Set-Service|install-caddy-host\.ps1 -(Install|Cutover|Rollback|Uninstall)\b[^'"]*$/m);
    expect(SCRIPT).not.toMatch(/&\s*[^\n]*install-caddy-host\.ps1/);
  });

  it('accept: 두 출발지(루프백·LAN)의 감사 IP, 루프백 버킷이 찬 직후 LAN 은 401, 8 KiB 헤더 통과를 판정한다', () => {
    const fn = fnBody('Invoke-Accept');
    expect(fn).toContain("if (-not $hc.Host) { Stop-WithError");
    expect(fn).toContain("$results['출발지별 IP'] = ($ip['loopback'] -eq '127.0.0.1' -and $ip['lan'] -eq $lan -and $ip['loopback'] -ne $ip['lan'])");
    const bucket = fnBody('Test-SeparateBuckets');
    before(bucket, "$c = Send-BadLogin '127.0.0.1' \"$Prefix-rl$i\"", '$lanAfter = Send-BadLogin $Lan');
    expect(fn).toContain("$results['로그인 제한 버킷 분리'] = ($bucket.Hit -and $bucket.LanAfter -eq '401')");
    // LAN 도 429 면(같은 창에 LAN 요청이 이미 있었음) 61초 뒤 두 버킷 모두 새 창에서 한 번 더(PR 리뷰 1회차 권고).
    expect(fn).toMatch(/if \(\$bucket\.Hit -and \$bucket\.LanAfter -eq '429'\) \{[\s\S]*?Start-Sleep -Seconds 61\s*\$bucket = Test-SeparateBuckets/);
    expect(fn).toContain("$results['8 KiB 헤더 통과'] = ((Send-PaddedHeader 8 $HttpsPort) -eq '200')");
    expect(fn).toMatch(/if \(\$failed -gt 0\) \{ exit 1 \}/);
    // 이전 실행의 1분 창이 남았으면 한 번만 61초 기다렸다 다시 보낸다.
    expect(fn).toMatch(/if \(\$codes\.Values -contains '429'\) \{[\s\S]*?Start-Sleep -Seconds 61/);
  });

  it('accept: 본문은 파일로(--data-binary @), LAN 주소는 파일에 쓰지 않고, 임시 파일은 finally 에서 지운다', () => {
    expect(fnBody('Send-BadLogin')).toContain('--data-binary "@$script:AcceptBody"');
    expect(fnBody('Send-BadLogin')).toContain('--resolve "${Domain}:${Port}:$Source"');
    const fn = fnBody('Invoke-Accept');
    expect(fn).not.toMatch(/(Set|Add|Out)-(Content|File)[^\n]*\$lan|WriteAllText[^\n]*\$lan|Write-Utf8NoBom[^\n]*\$lan/);
    expect(fn).toMatch(/\} finally \{\s*foreach \(\$f in \$script:AcceptBody, \$script:AcceptHeader\) \{ if \(Test-Path \$f\) \{ Remove-Item \$f -Force \} \}/);
  });
});
