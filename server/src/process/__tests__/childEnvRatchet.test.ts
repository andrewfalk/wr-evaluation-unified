// SEC-A L10 (P1-22) ratchet: every child process the server starts gets the filtered environment. A call to
// spawn / execFile / execFileAbortable in server code must pass `env` built by buildChildEnv — otherwise the child
// inherits DATABASE_URL and the secrets.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../..');
const CALL = /\b(spawn|execFile|execFileSync|execFileAsync|execFileAbortable|exec|execSync|fork)\s*\(/g;

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'testing' ? [] : serverFiles(p);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [p] : [];
  });
}

// The statement starting at `index` (up to its closing parenthesis).
function callText(src: string, index: number): string {
  let depth = 0;
  for (let i = src.indexOf('(', index); i < src.length; i += 1) {
    if (src[i] === '(') depth += 1;
    if (src[i] === ')' && --depth === 0) return src.slice(index, i + 1);
  }
  return src.slice(index);
}

describe('child processes get buildChildEnv (SEC-A L10)', () => {
  it('every spawn / execFile / execFileAbortable call passes env from buildChildEnv', () => {
    const offenders: string[] = [];
    let calls = 0;
    for (const file of serverFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join('/');
      if (rel === 'workers/abortableExec.ts') continue; // the wrapper itself forwards its caller's options
      const src = fs.readFileSync(file, 'utf8');
      if (!/from 'child_process'|from '\.\/abortableExec'|from '\.\.\/workers\/abortableExec'/.test(src)) continue;
      for (const m of src.matchAll(CALL)) {
        const before = src.slice(Math.max(0, m.index! - 40), m.index!);
        if (/(function|const|import|promisify\()\s*[\w{ ,]*$/.test(before) || /\/\/[^\n]*$/.test(before)) continue;
        calls += 1;
        const text = callText(src, m.index!);
        const ok = /env:\s*buildChildEnv\(/.test(text) || (/\{\s*env\b|,\s*env\s*[,}]/.test(text) && /const env = buildChildEnv\(/.test(src));
        if (!ok) offenders.push(`${rel}: ${text.split('\n')[0].trim()}`);
      }
    }
    expect(calls).toBeGreaterThanOrEqual(5); // stats spawn · GPU probe · sample detect · video infer + features
    expect(offenders).toEqual([]);
  });
});
