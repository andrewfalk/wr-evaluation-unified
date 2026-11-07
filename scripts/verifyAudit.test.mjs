// scripts/verify-audit.mjs — advisory extraction and allow-list comparison.
import { describe, expect, it } from 'vitest';
import { advisoriesFrom, evaluate, reachableLocations, advisoriesFor, versionInRange } from './verify-audit.mjs';

const audit = {
  vulnerabilities: {
    jspdf: {
      nodes: ['node_modules/jspdf'],
      via: [
        { url: 'https://github.com/advisories/GHSA-aaaa', severity: 'critical', title: 'A' },
        { url: 'https://github.com/advisories/GHSA-bbbb', severity: 'moderate', title: 'B' },
      ],
    },
    'html2pdf.js': { nodes: ['node_modules/html2pdf.js'], via: ['jspdf', { url: 'https://github.com/advisories/GHSA-cccc', severity: 'high', title: 'C' }] },
  },
};
const allowlist = {
  entries: [
    { workspace: 'root', package: 'jspdf', advisories: ['GHSA-aaaa', 'GHSA-gone'] },
    { workspace: 'server', package: 'html2pdf.js', advisories: ['GHSA-cccc'] },
  ],
};

describe('verify-audit', () => {
  it('extracts advisories, skipping inherited (string) entries', () => {
    expect(advisoriesFrom(audit).map((a) => `${a.package} ${a.id} ${a.severity}`)).toEqual([
      'jspdf GHSA-aaaa critical',
      'jspdf GHSA-bbbb moderate',
      'html2pdf.js GHSA-cccc high',
    ]);
  });

  it('fails on unreviewed high/critical, warns on unreviewed moderate/low, notes stale entries', () => {
    const r = evaluate('root', advisoriesFrom(audit), allowlist);
    // GHSA-cccc is allow-listed only for the server workspace, so it is unreviewed here.
    expect(r.failures.map((a) => a.id)).toEqual(['GHSA-cccc']);
    expect(r.warnings.map((a) => a.id)).toEqual(['GHSA-bbbb']);
    expect(r.stale).toEqual(['jspdf|GHSA-gone']);
  });

  it('passes when every high/critical advisory is reviewed', () => {
    const r = evaluate('root', advisoriesFrom(audit), {
      entries: [{ workspace: 'root', package: 'jspdf', advisories: ['GHSA-aaaa'] }, { workspace: 'root', package: 'html2pdf.js', advisories: ['GHSA-cccc'] }],
    });
    expect(r.failures).toEqual([]);
  });

  it('a new advisory on an already-reviewed package still fails', () => {
    const r = evaluate('root', advisoriesFrom(audit), { entries: [{ workspace: 'root', package: 'jspdf', advisories: ['GHSA-bbbb'] }] });
    expect(r.failures.map((a) => a.id)).toEqual(['GHSA-aaaa', 'GHSA-cccc']);
  });

  it('refuses unusable npm audit output instead of passing', () => {
    expect(() => advisoriesFrom({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } })).toThrow(/registry unreachable/);
    expect(() => advisoriesFrom({})).toThrow(/usable report/);
    expect(() => advisoriesFrom(null)).toThrow(/usable report/);
    // Malformed shapes must not read as "no vulnerabilities" (Codex review of #195).
    expect(() => advisoriesFrom({ vulnerabilities: [] })).toThrow(/usable report/);
    expect(() => advisoriesFrom({ vulnerabilities: { jspdf: {} } })).toThrow(/"jspdf" has no "via"/);
    expect(() => advisoriesFrom({ vulnerabilities: { jspdf: { via: 'x', nodes: [] } } })).toThrow(/"jspdf" has no "via"/);
    // Attribution needs the vulnerable install locations.
    expect(() => advisoriesFrom({ vulnerabilities: { jspdf: { via: [] } } })).toThrow(/"nodes"/);
  });

  it('accepts an empty but well-formed report', () => {
    expect(advisoriesFrom({ vulnerabilities: {} })).toEqual([]);
  });
});

describe('verify-audit workspace attribution (npm workspaces, one lockfile)', () => {
  // root depends on electron-updater (→ builder-util-runtime) and zod; server depends on bcrypt
  // (→ node-pre-gyp → tar), the @wr/contracts workspace (→ zod) and a vulnerable lodash@1 that is
  // nested under server/ while root uses a safe lodash@2. Root devDependencies are never production.
  const lock = {
    packages: {
      '': { dependencies: { 'electron-updater': '^6', zod: '^3', lodash: '^2' }, devDependencies: { vitest: '^1', '@wr/contracts': '*' } },
      server: { dependencies: { bcrypt: '^5', '@wr/contracts': '*', lodash: '^1' } },
      shared: { dependencies: { zod: '^3' }, devDependencies: { tsup: '^8' } },
      'node_modules/@wr/contracts': { resolved: 'shared', link: true },
      'node_modules/@wr/server': { resolved: 'server', link: true },
      'node_modules/electron-updater': { version: '6.0.0', dependencies: { 'builder-util-runtime': '^9' } },
      'node_modules/builder-util-runtime': { version: '9.0.0' },
      'node_modules/zod': { version: '3.25.76' },
      'node_modules/lodash': { version: '2.0.0' },
      'server/node_modules/lodash': { version: '1.0.0' },
      'node_modules/bcrypt': { version: '5.1.1', dependencies: { '@mapbox/node-pre-gyp': '^1' } },
      'node_modules/@mapbox/node-pre-gyp': { version: '1.0.11', dependencies: { tar: '^6' }, optionalDependencies: { missing: '*' } },
      'node_modules/tar': { version: '6.2.1' },
      'node_modules/vitest': { version: '1.6.0', dependencies: { tar: '^6' } },
      'node_modules/tsup': { version: '8.0.0' },
    },
  };
  const rootReach = reachableLocations(lock, '');
  const serverReach = reachableLocations(lock, 'server');
  const adv = (pkg, id, nodes) => ({ package: pkg, id, severity: 'high', title: id, nodes });

  it('follows production dependencies and workspace links, never devDependencies', () => {
    expect(serverReach.has('node_modules/tar')).toBe(true);
    expect(serverReach.has('node_modules/zod')).toBe(true); // via the @wr/contracts link → shared
    expect(serverReach.has('node_modules/tsup')).toBe(false); // shared devDependency
    expect(rootReach.has('node_modules/tar')).toBe(false); // only root's devDependency vitest uses tar
    expect(rootReach.has('node_modules/vitest')).toBe(false);
    expect(rootReach.has('node_modules/builder-util-runtime')).toBe(true);
  });

  it('a shared non-leaf package counts for every workspace that reaches it (no dedup blind spot)', () => {
    // zod is reached by root directly and by server through the workspace link; tar by server only.
    const advisories = [adv('zod', 'Z', ['node_modules/zod']), adv('tar', 'T', ['node_modules/tar'])];
    expect(advisoriesFor(rootReach, advisories).map((a) => a.id)).toEqual(['Z']);
    expect(advisoriesFor(serverReach, advisories).map((a) => a.id)).toEqual(['Z', 'T']);
  });

  it('attributes by install location, so a safe version elsewhere is not blamed', () => {
    const advisories = [adv('lodash', 'L', ['server/node_modules/lodash'])];
    expect(serverReach.has('server/node_modules/lodash')).toBe(true);
    expect(rootReach.has('server/node_modules/lodash')).toBe(false);
    expect(advisoriesFor(serverReach, advisories).map((a) => a.id)).toEqual(['L']);
    expect(advisoriesFor(rootReach, advisories)).toEqual([]);
  });

  it('resolves nested installs before hoisted ones (node resolution order)', () => {
    const nested = {
      packages: {
        '': { dependencies: { a: '*' } },
        'node_modules/a': { version: '1.0.0', dependencies: { b: '*' } },
        'node_modules/a/node_modules/b': { version: '2.0.0' },
        'node_modules/b': { version: '1.0.0' },
      },
    };
    const reach = reachableLocations(nested, '');
    expect(reach.has('node_modules/a/node_modules/b')).toBe(true);
    expect(reach.has('node_modules/b')).toBe(false);
  });

  it('tolerates an empty lock', () => {
    expect([...reachableLocations({}, '')]).toEqual(['']);
    expect([...reachableLocations(null, 'server')]).toEqual(['server']);
  });
});

describe('verify-audit per-advisory version ranges', () => {
  it('versionInRange handles npm audit range forms and refuses what it cannot read', () => {
    expect(versionInRange('6.2.1', '<7.5.7')).toBe(true);
    expect(versionInRange('7.5.7', '<7.5.7')).toBe(false);
    expect(versionInRange('2.5.0', '>=2.0.0 <3.0.6')).toBe(true);
    expect(versionInRange('3.0.6', '>=2.0.0 <3.0.6')).toBe(false);
    expect(versionInRange('1.0.0', '<=0.9.0 || >=1.0.0 <1.0.2')).toBe(true);
    expect(versionInRange('1.0.2', '<=0.9.0 || >=1.0.0 <1.0.2')).toBe(false);
    expect(versionInRange('1.0.0-rc.1', '<1.0.0')).toBe(true);
    expect(versionInRange('4.1.0', '*')).toBe(true);
    expect(versionInRange('1.2.3', '=1.2.3')).toBe(true);
    expect(versionInRange(undefined, '<1.0.0')).toBeNull();
    expect(versionInRange('1.0.0', '~1.0.0')).toBeNull();
    expect(versionInRange('1.0.0', '')).toBeNull();
  });

  it('two versions of one package vulnerable to different advisories are attributed separately', () => {
    // root uses foo@1.0.0 (only GHSA-A, <2), server uses foo@2.0.0 (only GHSA-B, >=2 <3).
    const lock = {
      packages: {
        '': { dependencies: { foo: '^1' } },
        server: { dependencies: { foo: '^2' } },
        'node_modules/foo': { version: '1.0.0' },
        'server/node_modules/foo': { version: '2.0.0' },
      },
    };
    const report = {
      vulnerabilities: {
        foo: {
          nodes: ['node_modules/foo', 'server/node_modules/foo'],
          via: [
            { url: 'https://github.com/advisories/GHSA-A', severity: 'high', title: 'A', range: '<2.0.0' },
            { url: 'https://github.com/advisories/GHSA-B', severity: 'high', title: 'B', range: '>=2.0.0 <3.0.0' },
          ],
        },
      },
    };
    const advisories = advisoriesFrom(report, lock);
    const rootAdv = advisoriesFor(reachableLocations(lock, ''), advisories);
    const serverAdv = advisoriesFor(reachableLocations(lock, 'server'), advisories);
    expect(rootAdv.map((a) => a.id)).toEqual(['GHSA-A']);
    expect(serverAdv.map((a) => a.id)).toEqual(['GHSA-B']);
    const allow = { entries: [{ workspace: 'root', package: 'foo', advisories: ['GHSA-A'] }, { workspace: 'server', package: 'foo', advisories: ['GHSA-B'] }] };
    expect(evaluate('root', rootAdv, allow).failures).toEqual([]);
    expect(evaluate('server', serverAdv, allow).failures).toEqual([]);
  });

  it('keeps a location whose version or the advisory range cannot be read (unknown = vulnerable)', () => {
    const lock = { packages: { 'node_modules/foo': {} } };
    const report = { vulnerabilities: { foo: { nodes: ['node_modules/foo'], via: [{ url: 'u/GHSA-X', severity: 'high', title: 'X', range: '<2.0.0' }] } } };
    expect(advisoriesFrom(report, lock)[0].nodes).toEqual(['node_modules/foo']);
  });
});
