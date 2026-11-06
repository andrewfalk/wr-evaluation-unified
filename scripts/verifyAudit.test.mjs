// scripts/verify-audit.mjs — advisory extraction and allow-list comparison.
import { describe, expect, it } from 'vitest';
import { advisoriesFrom, evaluate } from './verify-audit.mjs';

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
  });
});
