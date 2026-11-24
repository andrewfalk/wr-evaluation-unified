// REFACTORING_ROADMAP Phase 2 C7-a(P2-64) — 공용 코드(src/core/**)는 평가 모듈 폴더(src/modules/<id>/…)를 import하지 않는다.
// 편집 중 경고용 규칙의 검사다. 정확한 검사는 구조 래칫(scripts/arch-metrics.mjs coreToModulesImports)이 한다.
// 같은 규칙(no-restricted-imports)을 겹치는 블록에 두면 뒤 블록이 앞 것을 대체하므로, 환자 레코드 touch 금지(P2-39)가
// core 파일에서 그대로 오류인지도 함께 본다.
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function lintAs(relPath, code) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relPath) });
  return result.messages.map((m) => m.ruleId ?? m.message);
}

const count = (messages) => messages.filter((m) => m === 'no-restricted-imports').length;
const importLine = (specifier) => `import * as probe from '${specifier}';\nexport { probe };\n`;

describe('src/core → src/modules/<id>/ import 금지(P2-64)', () => {
  it('core 파일에서 모듈 폴더 안을 가리키면 오류(정적 import·re-export, .ts/.jsx 포함)', async () => {
    expect(count(await lintAs('src/core/utils/__p2_64_probe__.js', importLine('../../modules/knee/utils/data')))).toBe(1);
    expect(count(await lintAs('src/core/components/__p2_64_probe__.jsx', importLine('../../modules/spine/utils/sectionText')))).toBe(1);
    expect(count(await lintAs('src/core/narrative/__p2_64_probe__.ts', "export { kneeNarrative } from '../../modules/knee/narrative';\n"))).toBe(1);
  });

  it('core의 모듈 레지스트리·매니페스트(src/core/modules)와 @wr/analytics-core/modules/…는 통과', async () => {
    expect(count(await lintAs('src/core/__p2_64_probe__.js', importLine('./modules/registry')))).toBe(0);
    expect(count(await lintAs('src/core/utils/__p2_64_probe__.js', importLine('../modules/manifest')))).toBe(0);
    expect(count(await lintAs('src/core/utils/__p2_64_probe__.js', importLine('@wr/analytics-core/modules/elbow/index')))).toBe(0);
  });

  it('환자 상태 계층에도 모듈 금지는 걸리고, 그곳의 touch import는 그대로 허용', async () => {
    expect(count(await lintAs('src/core/state/__p2_64_probe__.ts', importLine('../../modules/knee/utils/data')))).toBe(1);
    expect(count(await lintAs('src/core/services/patientRecords.js', importLine('../../modules/knee/utils/data')))).toBe(1);
    const touch = "import { touchPatientRecord } from '../services/patientRecords';\nexport { touchPatientRecord };\n";
    expect(count(await lintAs('src/core/state/__p2_64_probe__.ts', touch))).toBe(0);
  });

  it('core 파일의 touchPatientRecord import는 여전히 오류(P2-39 규칙이 대체되지 않음)', async () => {
    const touch = "import { touchPatientRecord } from '../services/patientRecords';\nexport { touchPatientRecord };\n";
    expect(count(await lintAs('src/core/hooks/__p2_64_probe__.js', touch))).toBe(1);
    expect(count(await lintAs('src/core/components/__p2_64_probe__.jsx', touch))).toBe(1);
  });

  it('테스트·core 밖(src/app 등)은 예외', async () => {
    expect(count(await lintAs('src/core/utils/__tests__/__p2_64_probe__.test.js', importLine('../../../modules/knee/utils/data')))).toBe(0);
    expect(count(await lintAs('src/core/utils/__p2_64_probe__.test.ts', importLine('../../modules/knee/utils/data')))).toBe(0);
    expect(count(await lintAs('src/app/__p2_64_probe__.ts', importLine('../modules/knee/utils/data')))).toBe(0);
  });
});
