// scripts/arch-metrics.mjs — counting rules (REFACTORING_ROADMAP Phase 2 P2-01).
import { describe, expect, it } from 'vitest';
import { coreToModulesLines, inlineStyleHexCount, isProductCode, scanFile } from './arch-metrics.mjs';

describe('arch-metrics', () => {
  it('product code excludes tests, src/testing and declaration files', () => {
    expect(isProductCode('src/App.jsx')).toBe(true);
    expect(isProductCode('src/platform/runtime.ts')).toBe(true);
    expect(isProductCode('src/core/fixtures/createTestPatients.js')).toBe(true);
    expect(isProductCode('src/core/__tests__/x.test.js')).toBe(false);
    expect(isProductCode('src/core/hooks/__tests__/helper.js')).toBe(false);
    expect(isProductCode('src/App.smoke.test.jsx')).toBe(false);
    expect(isProductCode('src/testing/renderApp.jsx')).toBe(false);
    expect(isProductCode('src/types/global.d.ts')).toBe(false);
  });

  it('counts window.electron lines outside the bridge adapter, ignoring comments', () => {
    const src = '// window.electron in a comment\nconst a = window.electron?.x;\nconst b = window\n  .electron;\n';
    expect(scanFile('src/core/a.js', src)).toMatchObject({ windowElectronLines: 2, windowElectronFiles: 1 });
    expect(scanFile('src/platform/bridge.ts', 'export const b = () => window.electron;')).toEqual({});
  });

  it('counts core → modules imports by resolved path (static, side-effect, dynamic, re-export)', () => {
    const src = [
      "import { a } from '../../modules/knee/x';",
      "import '../../modules/spine';",
      "import '../modules/notModules';", // src/core/modules — not src/modules
      "export { b } from '../../modules/elbow/y';",
      "const c = await import('../../modules/wrist/z');",
      'const t = () => import(`../../modules/knee/index.js`);',
      'const dyn = (id) => import(`../../modules/${id}/index.js`); // not a static path — not counted',
      "import d from '../utils/modulesHelper';",
      "import e from './modules/local';",
    ].join('\n');
    expect(coreToModulesLines('src/core/utils/r.js', src)).toBe(5);
    expect(coreToModulesLines('src/modules/knee/index.js', "import x from '../spine/a';")).toBe(0);
  });

  it('counts raw fetch calls outside the request layer only', () => {
    const src = "await fetch('/a');\nawait window.fetch('/b');\nthis.fetchAll();\nrefetch();\n// fetch('/c')\n";
    expect(scanFile('src/core/auth/x.js', src).rawFetch).toBe(1);
    expect(scanFile('src/core/services/httpClient.js', src).rawFetch).toBeUndefined();
    expect(scanFile('src/core/api/apiClient.ts', src).rawFetch).toBeUndefined();
  });

  it('counts files touching web storage outside the storage registry', () => {
    expect(scanFile('src/a.js', 'sessionStorage.getItem("k");').webStorageFiles).toBe(1);
    expect(scanFile('src/a.js', '// localStorage only in a comment').webStorageFiles).toBeUndefined();
    expect(scanFile('src/core/storage/keys.ts', 'localStorage.getItem("k");').webStorageFiles).toBeUndefined();
  });

  it('counts intranet mode comparisons outside src/platform (comments ignored)', () => {
    const src = [
      "if (session?.mode === 'intranet') a();",
      "const b = settings.integrationMode !== 'intranet';",
      "const c = 'intranet' === session?.mode;",
      "const d = mode == \"intranet\";",
      "// session.mode === 'intranet' in a comment",
      "const e = hasIntranetSession(session);",
      "const f = remode === 'intranet';", // a different identifier — not counted
    ].join('\n');
    expect(scanFile('src/core/a.js', src).intranetModeComparisons).toBe(4);
    expect(scanFile('src/platform/dataMode.ts', "return session?.mode === 'intranet';").intranetModeComparisons).toBeUndefined();
  });

  it('counts raw hex in CSS (not in comments, not in tokens.css) and inside inline styles', () => {
    expect(scanFile('src/index.css', '.a { color: #fff; } /* #000 */ .b { border: 1px solid #12345678; }').cssRawHex).toBe(2);
    expect(scanFile('src/styles/tokens.css', ':root { --c: #fff; }').cssRawHex).toBeUndefined();
    expect(inlineStyleHexCount('<div style={{ color: "#fff", nested: { b: "#000" } }} /> const x = "#abc";')).toBe(2);
    expect(inlineStyleHexCount('<div style={ { color: "#fff" } } /><p style = {\n  {\n    color: "#000" } } />')).toBe(2);
  });
});
