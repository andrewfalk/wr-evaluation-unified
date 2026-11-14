// scripts/ts-progress.mjs — counting and the TS-only layer rule (REFACTORING_ROADMAP Phase 2 P2-01).
import { describe, expect, it } from 'vitest';
import { summarize } from './ts-progress.mjs';

describe('ts-progress', () => {
  it('counts product lines only and reports the TS share', () => {
    const s = summarize([
      { rel: 'src/App.jsx', lines: 300 },
      { rel: 'src/platform/runtime.ts', lines: 100 },
      { rel: 'src/core/x.test.js', lines: 999 },
      { rel: 'src/types/global.d.ts', lines: 999 },
      { rel: 'src/testing/renderApp.jsx', lines: 999 },
    ]);
    expect(s).toMatchObject({ tsFiles: 1, tsLines: 100, jsFiles: 1, jsLines: 300, linesPct: 25, jsInTsOnlyLayers: [] });
  });

  it('keeps the exact ratio for the floor (44.96% is below 45 even though it displays as 45)', () => {
    const s = summarize([{ rel: 'src/a.ts', lines: 4496 }, { rel: 'src/b.js', lines: 5504 }]);
    expect(s.linesPct).toBe(45);
    expect(s.linesRatio * 100).toBeLessThan(45);
  });

  it('flags JavaScript inside the new Phase 2 layers', () => {
    const s = summarize([
      { rel: 'src/platform/bridge.js', lines: 10 },
      { rel: 'src/core/api/apiClient.jsx', lines: 10 },
      { rel: 'src/core/storage/__tests__/keys.test.js', lines: 10 },
      { rel: 'src/core/services/httpClient.js', lines: 10 },
    ]);
    expect(s.jsInTsOnlyLayers).toEqual(['src/platform/bridge.js', 'src/core/api/apiClient.jsx']);
  });
});
