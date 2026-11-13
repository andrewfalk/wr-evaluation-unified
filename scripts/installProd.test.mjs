import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// scripts/install-prod.ps1 — M9(7.3.0~) 역할 분리에 맞춘 부분. 7.2.0 이하 패키지(migrate 서비스 없음)와 7.3.0 패키지를 모두 받는다.
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SCRIPT = readFileSync(path.join(ROOT, 'scripts', 'install-prod.ps1'), 'utf8').replace(/\r\n/g, '\n');

describe('install-prod.ps1 — M9 역할 분리', () => {
  it('OWNER_DB_PASSWORD·APP_DB_PASSWORD 는 있으면 영숫자·_·- 만 허용한다(partition 의 PGPASSWORD 원문과 URL 해석이 어긋나지 않게)', () => {
    expect(SCRIPT).toMatch(/foreach \(\$key in 'OWNER_DB_PASSWORD', 'APP_DB_PASSWORD'\) \{[\s\S]*?if \(\$null -eq \$value\) \{ continue \}[\s\S]*?\$value -notmatch '\^\[A-Za-z0-9_-\]\+\$'[\s\S]*?exit 1/);
  });

  it('검증은 compose 기동 전에 한다', () => {
    expect(SCRIPT.indexOf("foreach ($key in 'OWNER_DB_PASSWORD'")).toBeLessThan(SCRIPT.indexOf('docker compose @upArgs'));
  });

  it('migrate 서비스 유무는 해석된 설정(config --services)으로 판정한다', () => {
    expect(SCRIPT).toMatch(/\$servicesArgs = \$composeArgs\[0\.\.\(\$composeArgs\.Count - 3\)\] \+ @\("config", "--services"\)/);
    expect(SCRIPT).toMatch(/\$hasMigrate = @\(Invoke-Native \{ docker compose @servicesArgs \}\) -contains "migrate"/);
  });

  it('수동 ALTER ROLE 안내는 migrate 서비스가 없을 때(7.2.0 이하)만 나온다', () => {
    const at = SCRIPT.indexOf('ALTER ROLE wr_audit_reader');
    const guard = SCRIPT.lastIndexOf('if (-not $hasMigrate) {', at);
    expect(at).toBeGreaterThan(0);
    expect(guard).toBeGreaterThan(0);
    expect(SCRIPT.slice(guard, at)).not.toContain('\n}');
  });

  it('compose up 이 실패하면 migrate 로그 확인 명령을 안내한다', () => {
    expect(SCRIPT).toMatch(/docker compose up failed[\s\S]*?if \(\$hasMigrate\) \{[\s\S]*?logs migrate/);
  });
});
