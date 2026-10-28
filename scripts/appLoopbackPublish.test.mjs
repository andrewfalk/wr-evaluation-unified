import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

// 앱 루프백 게시(127.0.0.1:<WR_APP_PORT>) 불변식. 운영 서버의 Compose v2.22.0 공식 바이너리로 확인한 사실에 기댄다:
//  - `!override` 태그는 오류 없이 무시되어 base 의 게시가 남는다(전 주소 노출) → 저장소 compose 파일에서 금지.
//  - prod 의 "127.0.0.1:${WR_APP_PORT:-3001}:3001" 은 WR_APP_PORT=0.0.0.0:3001 을 넣으면 주소 오류로 중단되고,
//    예전 DEV_PORT(env 파일·셸)는 무시된다 → 호스트 주소는 파일에 고정, 변수는 포트 번호만.
//  - base 에 app 게시가 없으면 병합 의미(버전마다 다름)에 기대지 않는다.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

// js-yaml 은 Compose 전용 태그를 모른다 — 값만 표시해 두고 구조를 읽는다(!override 가 들어와도 파싱은 되어
// 아래 전용 테스트가 원인을 보고하게).
const tag = (name, kind) => new yaml.Type(name, { kind, construct: (v) => ({ [`$${name.slice(1)}`]: v }) });
const COMPOSE_SCHEMA = yaml.DEFAULT_SCHEMA.extend(
  ['!reset', '!override'].flatMap((n) => ['scalar', 'sequence', 'mapping'].map((k) => tag(n, k))),
);
const loadCompose = (p) => yaml.load(read(p), { schema: COMPOSE_SCHEMA });

const BASE = loadCompose('docker-compose.yml');
const PROD = loadCompose('docker-compose.prod.yml');
const OVERRIDE = loadCompose('docker-compose.override.yml');
const CHECK = read('scripts/check-app-publish.ps1');
const INSTALL = read('scripts/install-prod.ps1');
const EXPORT = read('scripts/export-offline-package.ps1');
const ENV_EXAMPLE = read('.env.production.example');

// 도움말 블록(<# #>)과 # 주석을 걷어낸 실행 코드 — 설명 문구의 "docker compose ... up -d" 등에 검사가 걸리지 않게.
const CHECK_CODE = CHECK.replace(/<#[\s\S]*?#>/g, '')
  .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
// Invoke-Native { ... } 블록(중괄호 균형)의 본문 목록과, 그 블록을 걷어낸 나머지.
const splitNativeBlocks = (src) => {
  const bodies = [];
  let rest = src.replace(/function Invoke-Native \{[\s\S]*?\n\}/, ''); // 정의 자체는 호출이 아니다
  for (;;) {
    const start = rest.indexOf('Invoke-Native {');
    if (start < 0) break;
    const open = rest.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < rest.length; i++) {
      if (rest[i] === '{') depth++;
      else if (rest[i] === '}' && --depth === 0) { end = i; break; }
    }
    if (end < 0) throw new Error('Invoke-Native 블록의 중괄호가 맞지 않습니다');
    bodies.push(rest.slice(open + 1, end).trim());
    rest = rest.slice(0, start) + rest.slice(end + 1);
  }
  return { bodies, rest };
};

describe('compose 파일 — 앱 게시', () => {
  it('저장소의 어떤 compose 파일도 !override 를 쓰지 않는다(운영 Compose v2.22.0 은 조용히 무시한다)', () => {
    const files = readdirSync(ROOT).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(3);
    // 주석("!override 를 쓰지 말 것")은 제외하고 YAML 값만 본다.
    for (const f of files) {
      const code = read(f).split('\n').map((l) => l.replace(/#.*$/, '')).join('\n');
      expect(code, f).not.toMatch(/!override\b/);
    }
  });

  it('base 에는 app 게시가 없다 — 운영 오버레이가 지울 방법이 필요 없게', () => {
    expect(BASE.services.app).toBeDefined();
    expect(BASE.services.app.ports).toBeUndefined();
  });

  it('prod 는 app 을 127.0.0.1 고정 + 포트 번호만 변수로 게시한다', () => {
    expect(PROD.services.app.ports).toEqual(['127.0.0.1:${WR_APP_PORT:-3001}:3001']);
  });

  it('개발용 게시는 자동 로드되는 override 에만 있다(개발 동작 그대로)', () => {
    expect(OVERRIDE.services.app.ports).toEqual(['${DEV_PORT:-3001}:3001']);
  });

  it('오프라인 패키지에는 base·prod 만 들어가고 override 는 들어가지 않는다', () => {
    const copied = EXPORT.match(/foreach \(\$f in @\(([^)]*)\)\)\s*\{/)?.[1] ?? '';
    expect(copied).toContain('"docker-compose.yml"');
    expect(copied).toContain('"docker-compose.prod.yml"');
    expect(copied).not.toContain('override');
  });

  it('Caddy 게시 주소는 변수지만 기본값은 이전과 같은 8080/8443 이다', () => {
    expect(BASE.services.caddy.ports).toEqual(['${WR_CADDY_HTTP_BIND:-8080}:80', '${WR_CADDY_HTTPS_BIND:-8443}:443']);
  });

  it('prod 의 build 는 여전히 !reset 으로 지운다(v2.17+ 에서 동작, 운영 v2.22.0 에서 사용 중)', () => {
    expect(PROD.services.app.build).toEqual({ $reset: 'null' });
  });

  it('예제 env 는 WR_APP_PORT(번호만)를 쓰고 DEV_PORT 를 설정하지 않는다', () => {
    expect(ENV_EXAMPLE).toMatch(/^WR_APP_PORT=3001$/m);
    expect(ENV_EXAMPLE).not.toMatch(/^\s*DEV_PORT=/m);
  });
});

describe('check-app-publish.ps1 — 읽기 전용 사전 점검', () => {
  it('서버(Windows PowerShell 5.1)에서 돈다 — 5.1 요구, ASCII 만', () => {
    expect(CHECK.startsWith('#Requires -Version 5.1')).toBe(true);
    const bad = [...CHECK].filter((c) => c.charCodeAt(0) > 0x7f);
    expect(bad).toEqual([]);
    expect(CHECK).not.toMatch(/\?\?|\?\.|-SkipHttpErrorCheck|\)\s*&&\s|\)\s*\|\|\s/);
  });

  it('docker 호출은 모두 Invoke-Native 안에 있다(5.1 은 stderr 경고에도 중단한다)', () => {
    const { bodies, rest } = splitNativeBlocks(CHECK_CODE);
    expect(bodies.filter((b) => /\bdocker\s/.test(b)).length).toBeGreaterThanOrEqual(3);
    const outside = rest.split('\n').filter((l) => /^\s*(?:&\s*)?docker\s/.test(l));
    expect(outside).toEqual([]);
  });

  it('읽기 전용이다 — docker 는 ps·inspect·compose config 만 부르고, 파일·프로세스를 바꾸지 않는다', () => {
    const { bodies } = splitNativeBlocks(CHECK_CODE);
    for (const b of bodies) {
      const cmd = b.replace(/\s+/g, ' ');
      expect(cmd, b).toMatch(/^docker (ps -q|inspect \$ids|info --format '\{\{\.OperatingSystem\}\}'|version --format '\{\{\.Server\.Version\}\}'|compose -f docker-compose\.yml -f docker-compose\.prod\.yml --env-file \$EnvFile -p \$ProjectName config --format json)( |$)/);
    }
    const statements = CHECK_CODE.split('\n').map((l) => l.trim());
    for (const s of statements) expect(s).not.toMatch(/^(?:&\s*)?(Stop-Process|Remove-Item|Set-Content|Add-Content|Out-File|New-Item)\b/);
  });

  it('셸 덮어쓰기 변수 3종을 거부한다', () => {
    expect(CHECK).toMatch(/\$ShellOverrideKeys = @\('WR_APP_PORT', 'WR_CADDY_HTTPS_BIND', 'WR_CADDY_HTTP_BIND'\)/);
    expect(CHECK).toMatch(/Where-Object \{ Test-Path "env:\$_" \}/);
  });

  it('해석된 설정의 app 게시가 127.0.0.1·환경 파일 포트가 아니면 중단한다(게시가 아예 없어도 중단)', () => {
    expect(CHECK).toMatch(/config --format json/);
    expect(CHECK).toMatch(/if \(\$appPorts\.Count -eq 0\)\s*\{\s*Stop-Check/);
    expect(CHECK).toMatch(/if \(\$hostIp -ne '127\.0\.0\.1'\)\s*\{\s*Stop-Check/);
    expect(CHECK).toMatch(/if \(\[string\]\$p\.published -ne \[string\]\$expected\)\s*\{\s*Stop-Check/);
  });

  it('Docker Desktop 이 아닌 엔진은 28.0.0 미만이면 중단한다(moby#45610: localhost 게시가 L2 에서 닿음)', () => {
    expect(CHECK).toMatch(/^\$MinLinuxEngineMajor = 28\b/m);
    const at = CHECK.indexOf("if ($dockerOs -match 'Docker Desktop')");
    expect(at).toBeGreaterThan(0);
    const block = CHECK.slice(at, CHECK.indexOf('# 2.', at));
    expect(block).toMatch(/\} else \{[\s\S]*?if \(\$major -lt \$MinLinuxEngineMajor\) \{\s*Stop-Check/);
    // 엔진을 못 읽으면 통과시키지 않는다
    expect(CHECK).toMatch(/if \(\$LASTEXITCODE -ne 0 -or -not \$dockerOs\) \{ Stop-Check/);
    expect(CHECK).toMatch(/if \(\$LASTEXITCODE -ne 0 -or -not \$engine\) \{ Stop-Check/);
    // 게시 판정·포트 점검보다 먼저 본다
    expect(at).toBeLessThan(CHECK.indexOf('config --format json'));
  });

  it('WR_APP_PORT 는 번호만 허용한다(주소를 넣으면 중단)', () => {
    expect(CHECK).toMatch(/\$value -notmatch '\^\\d\{1,5\}\$'/);
  });

  it('점유자는 실제 HostPort 매핑·compose 라벨로 판단하고, 자기 프로젝트의 app 만 통과시킨다', () => {
    expect(CHECK_CODE).not.toMatch(/--filter\s+"?publish=/);
    expect(CHECK).toMatch(/NetworkSettings\.Ports/);
    expect(CHECK).toMatch(/com\.docker\.compose\.project/);
    expect(CHECK).toMatch(/-not \(\$_\.Project -eq \$ProjectName -and \$_\.Service -eq 'app'\)/);
    expect(CHECK).toMatch(/Get-NetTCPConnection -State Listen -LocalPort \$expected/);
  });

  it('설치 스크립트가 compose up 전에 실행하고, 실패하면 중단한다', () => {
    const call = INSTALL.indexOf('check-app-publish.ps1');
    const up = INSTALL.indexOf('"up", "-d"');
    expect(call).toBeGreaterThan(0);
    expect(call).toBeLessThan(up);
    expect(INSTALL.slice(call, call + 300)).toMatch(/if \(\$LASTEXITCODE -ne 0\)\s*\{[\s\S]*?exit 1/);
  });

  it('오프라인 패키지의 scripts\\ 로 복사된다', () => {
    const helper = EXPORT.match(/\$helperScripts\s*=\s*@\(([^)]*)\)/)?.[1] ?? '';
    expect(helper).toContain('"check-app-publish.ps1"');
  });
});
