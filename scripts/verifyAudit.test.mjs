// scripts/verify-audit.mjs — advisory extraction and allow-list comparison.
import { describe, expect, it } from 'vitest';
import { advisoriesFrom, evaluate, ownersFrom, advisoriesFor } from './verify-audit.mjs';

const audit = {
  vulnerabilities: {
    jspdf: {
      via: [
        { url: 'https://github.com/advisories/GHSA-aaaa', severity: 'critical', title: 'A' },
        { url: 'https://github.com/advisories/GHSA-bbbb', severity: 'moderate', title: 'B' },
      ],
    },
    'html2pdf.js': { via: ['jspdf', { url: 'https://github.com/advisories/GHSA-cccc', severity: 'high', title: 'C' }] },
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
    expect(() => advisoriesFrom({ vulnerabilities: { jspdf: { via: 'x' } } })).toThrow(/"jspdf" has no "via"/);
  });

  it('accepts an empty but well-formed report', () => {
    expect(advisoriesFrom({ vulnerabilities: {} })).toEqual([]);
  });
});

describe('verify-audit workspace attribution (npm workspaces, one lockfile)', () => {
  const ls = {
    dependencies: {
      'electron-updater': { version: '6.0.0', dependencies: { 'builder-util-runtime': { version: '9.0.0' } } },
      zod: { version: '3.25.76' },
      '@wr/server': {
        version: '0.1.0',
        dependencies: {
          bcrypt: { version: '5.1.1', dependencies: { '@mapbox/node-pre-gyp': { version: '1.0.11', dependencies: { tar: { version: '6.2.1' } } } } },
          '@wr/contracts': { version: '0.1.0', dependencies: { zod: { version: '3.25.76' } } },
        },
      },
    },
  };

  it('attributes packages under @wr/server to "server" and everything else to "root"', () => {
    const owners = ownersFrom(ls);
    expect([...owners.get('tar')]).toEqual(['server']);
    expect([...owners.get('builder-util-runtime')]).toEqual(['root']);
    expect([...owners.get('zod')].sort()).toEqual(['root', 'server']);
    expect(owners.has('@wr/server')).toBe(false);
    expect(owners.has('@wr/contracts')).toBe(false);
  });

  it('filters advisories per workspace', () => {
    const owners = ownersFrom(ls);
    const advisories = [
      { package: 'tar', id: 'A', severity: 'high' },
      { package: 'zod', id: 'B', severity: 'high' },
      { package: 'electron-updater', id: 'C', severity: 'high' },
    ];
    expect(advisoriesFor('server', advisories, owners).map((a) => a.id)).toEqual(['A', 'B']);
    expect(advisoriesFor('root', advisories, owners).map((a) => a.id)).toEqual(['B', 'C']);
  });

  it('tolerates an empty tree', () => {
    expect(ownersFrom({}).size).toBe(0);
    expect(ownersFrom(null).size).toBe(0);
  });
});
