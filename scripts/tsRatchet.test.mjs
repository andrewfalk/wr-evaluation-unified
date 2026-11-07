import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasLeadingNocheck, compareToBaseline, findNocheckFiles } from './ts-ratchet.mjs';

describe('hasLeadingNocheck', () => {
  it('finds the directive in the leading comments only', () => {
    expect(hasLeadingNocheck('// @ts-nocheck\nimport x from "y";')).toBe(true);
    expect(hasLeadingNocheck('﻿\n\n  // @ts-nocheck\n')).toBe(true);
    expect(hasLeadingNocheck('// header\n/* block */\n// @ts-nocheck\nconst a = 1;')).toBe(true);
    expect(hasLeadingNocheck('/** @ts-nocheck */\nconst a = 1;')).toBe(true);
    expect(hasLeadingNocheck('const a = 1;\n// @ts-nocheck\n')).toBe(false);
    expect(hasLeadingNocheck('// @ts-nocheckx\n')).toBe(false);
    expect(hasLeadingNocheck('// @ts-check\n')).toBe(false);
    expect(hasLeadingNocheck('/* unterminated')).toBe(false);
    expect(hasLeadingNocheck('')).toBe(false);
  });
});

describe('compareToBaseline', () => {
  it('reports files added to and gone from the nocheck list', () => {
    expect(compareToBaseline(['a', 'c'], ['a', 'b'])).toEqual({ added: ['c'], removed: ['b'] });
    expect(compareToBaseline(['a'], ['a'])).toEqual({ added: [], removed: [] });
  });
});

describe('findNocheckFiles', () => {
  it('scans src/ recursively, skips node_modules, returns sorted repo-relative paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-ratchet-'));
    try {
      const write = (rel, text) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), text);
      };
      write('src/b/x.jsx', '// @ts-nocheck\n');
      write('src/a.js', '// @ts-nocheck\nexport {};\n');
      write('src/ok.js', 'export {};\n');
      write('src/node_modules/m.js', '// @ts-nocheck\n');
      write('src/readme.md', '// @ts-nocheck\n');
      expect(findNocheckFiles(root)).toEqual(['src/a.js', 'src/b/x.jsx']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('repository baseline', () => {
  it('matches the current @ts-nocheck files exactly', () => {
    const baseline = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'ts-nocheck-baseline.json'), 'utf8'));
    expect(findNocheckFiles()).toEqual(baseline);
  });
});
