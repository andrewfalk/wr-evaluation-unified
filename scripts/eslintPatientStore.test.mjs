// REFACTORING_ROADMAP Phase 2 C4(P2-39) — touchPatientRecord import는 환자 상태 전이(src/core/state/**)·BatchImportModal·테스트만.
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

describe('touchPatientRecord import 금지(P2-39)', () => {
  const code = "import { touchPatientRecord } from '../services/patientRecords';\nexport const t = touchPatientRecord;\n";
  const deep = "import { touchPatientRecord as t } from '../../services/patientRecords.js';\nexport { t };\n";
  const other = "import { createManagedPatient } from '../services/patientRecords';\nexport { createManagedPatient };\n";

  it('훅·컴포넌트·App에서는 금지(별칭·.js 경로 포함)', async () => {
    expect(count(await lintAs('src/core/hooks/__p2_39_probe__.js', code))).toBe(1);
    expect(count(await lintAs('src/core/components/__p2_39_probe__.jsx', code))).toBe(1);
    expect(count(await lintAs('src/app/__p2_39_probe__.ts', code))).toBe(1);
    expect(count(await lintAs('src/core/utils/sub/__p2_39_probe__.js', deep))).toBe(1);
    // 같은 폴더 상대경로(#321 Codex 권고)
    const sameDir = "import { touchPatientRecord } from './patientRecords';\nexport { touchPatientRecord };\n";
    expect(count(await lintAs('src/core/services/__p2_39_probe__.js', sameDir))).toBe(1);
  });

  it('같은 모듈의 다른 export는 허용', async () => {
    expect(count(await lintAs('src/core/hooks/__p2_39_probe__.js', other))).toBe(0);
  });

  it('환자 상태 계층·일괄 가져오기 모달·테스트는 예외', async () => {
    expect(count(await lintAs('src/core/state/patientStore/__p2_39_probe__.ts', deep))).toBe(0);
    expect(count(await lintAs('src/core/components/BatchImportModal.jsx', code))).toBe(0);
    expect(count(await lintAs('src/core/hooks/__tests__/__p2_39_probe__.test.js', code))).toBe(0);
    expect(count(await lintAs('src/testing/__p2_39_probe__.js', code))).toBe(0);
  });
});
