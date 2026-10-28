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
    expect(fn).toMatch(/foreach \(\$port in \$HttpsPort, \$HttpPort, \(Get-AppPort\)\)/);
    expect(fn).toMatch(/\$_\.Project -ne \$ProjectName/);
    expect(fn).toMatch(/if\s*\(\$others\.Count -gt 0\)\s*\{\s*Stop-WithError/);
    expect(fn).not.toMatch(/Stop-Process|docker (stop|rm|kill)/);
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
    expect(SCRIPT).toMatch(/\$ShellOverrideKeys = @\('WR_APP_PORT', 'WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND'\)/);
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
    expect(fn).toMatch(/if\s*\(-not \$restarted -and \$p\.Error -match 'NotTimeValid'\)/);
    expect(fn).toMatch(/Invoke-Compose @\('restart', 'caddy'\)/);
    expect(fn).toMatch(/\$restarted = \$true/);
    expect(up()).toContain('Wait-Https');
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
