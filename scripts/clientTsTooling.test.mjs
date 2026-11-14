// REFACTORING_ROADMAP Phase 2 P2-00 — client TypeScript must not fall through the tooling holes.
// New client code is .ts/.tsx from Phase 2 on; before P2-00 the root ESLint config linted only
// .js/.jsx/.mjs/.cjs, vitest did not pick up .test.tsx, and verify-browser-compat scanned only
// .js/.jsx/.css. These tests pin each hole shut (verify-browser-compat's TS handling is tested in
// verifyBrowserCompat.test.mjs).
import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import vitestConfig from '../vitest.config.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function lintAs(relPath, code) {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relPath) });
  return result.messages.map((m) => m.ruleId ?? m.message);
}

describe('client TS tooling (P2-00)', () => {
  it('root ESLint lints src/**/*.tsx with the react-hooks rules', async () => {
    const code = [
      "import { useState } from 'react';",
      'export function Probe({ on }: { on: boolean }) {',
      '  if (on) {',
      '    const [v] = useState<number>(0);',
      '    return <span>{v}</span>;',
      '  }',
      '  return null;',
      '}',
      '',
    ].join('\n');
    expect(await lintAs('src/__p2_00_probe__.tsx', code)).toContain('react-hooks/rules-of-hooks');
  });

  it('root ESLint lints src/**/*.ts with typescript-eslint (unused vars, TS syntax parses)', async () => {
    const messages = await lintAs('src/__p2_00_probe__.ts', 'const unused: number = 1;\nexport type T = { a: string };\n');
    expect(messages).toContain('@typescript-eslint/no-unused-vars');
    expect(messages.some((m) => /Parsing error/.test(m))).toBe(false);
  });

  it('declaration files under src/types are not linted (they describe external shapes with any)', async () => {
    const eslint = new ESLint({ cwd: root });
    expect(await lintAs('src/types/__probe__.d.ts', 'declare const x: any;\n')).toEqual([
      expect.stringMatching(/File ignored|no matching configuration/i),
    ]);
  });

  it('window.electron is forbidden outside src/platform/bridge.ts (P2-15), tests and helpers excepted', async () => {
    const code = [
      'export const a = window.electron?.fsLoadItems;',
      'export const b = window?.electron;',
      'const { electron } = window;',
      'export { electron };',
      '',
    ].join('\n');
    const rule = 'no-restricted-properties';
    const count = (messages) => messages.filter((m) => m === rule).length;
    expect(count(await lintAs('src/core/__p2_15_probe__.js', code))).toBe(3);
    expect(count(await lintAs('src/core/__p2_15_probe__.tsx', code))).toBe(3);
    expect(count(await lintAs('src/platform/bridge.ts', code))).toBe(0);
    expect(count(await lintAs('src/testing/__p2_15_probe__.js', code))).toBe(0);
    expect(count(await lintAs('src/core/__tests__/__p2_15_probe__.test.js', code))).toBe(0);
  });

  it('vitest picks up .test.tsx and __tests__/*.tsx under src', () => {
    const include = vitestConfig.test.include;
    expect(include).toContain('src/**/*.test.{js,jsx,ts,tsx}');
    expect(include).toContain('src/**/__tests__/**/*.{js,jsx,ts,tsx}');
  });
});
