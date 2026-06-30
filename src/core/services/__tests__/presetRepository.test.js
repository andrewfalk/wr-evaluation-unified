import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  isOwnPreset,
  getPresetSourceKind,
  getPresetOwnerName,
  getPresetVisibility,
  mergePresets,
  saveCustomPreset,
} from '../presetRepository.js';

vi.mock('../httpClient.js', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../httpClient.js';

const INTRANET = { mode: 'intranet', user: { id: 'u1' }, apiBaseUrl: 'http://x' };
const LOCAL = { mode: undefined, user: { id: 'u1' } };

beforeEach(() => {
  requestJson.mockReset();
});

// ---------------------------------------------------------------------------
// isOwnPreset
// ---------------------------------------------------------------------------

describe('isOwnPreset', () => {
  it('intranet: own when ownerUserId matches session user', () => {
    expect(isOwnPreset({ source: 'custom', ownerUserId: 'u1' }, INTRANET)).toBe(true);
  });

  it('intranet: not own when ownerUserId is another user', () => {
    expect(isOwnPreset({ source: 'custom', ownerUserId: 'u2' }, INTRANET)).toBe(false);
  });

  it('intranet: not own when owner is unknown/missing', () => {
    expect(isOwnPreset({ source: 'custom' }, INTRANET)).toBe(false);
  });

  it('local: own when owner is missing (single user)', () => {
    expect(isOwnPreset({ source: 'custom' }, LOCAL)).toBe(true);
  });

  it('builtin without custom overlay is never own', () => {
    expect(isOwnPreset({ source: 'builtin' }, INTRANET)).toBe(false);
    expect(isOwnPreset({ source: 'builtin' }, LOCAL)).toBe(false);
  });

  it('uses _customOwnerUserId for builtin-overlay presets', () => {
    expect(isOwnPreset({ source: 'builtin', _customId: 'c1', _customOwnerUserId: 'u1' }, INTRANET)).toBe(true);
    expect(isOwnPreset({ source: 'builtin', _customId: 'c1', _customOwnerUserId: 'u2' }, INTRANET)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getPresetSourceKind
// ---------------------------------------------------------------------------

describe('getPresetSourceKind', () => {
  it('classifies builtin / own / shared', () => {
    expect(getPresetSourceKind({ source: 'builtin' }, INTRANET)).toBe('builtin');
    expect(getPresetSourceKind({ source: 'custom', ownerUserId: 'u1' }, INTRANET)).toBe('own');
    expect(getPresetSourceKind({ source: 'custom', ownerUserId: 'u2' }, INTRANET)).toBe('shared');
  });

  it('builtin-overlay owned by another user is shared, not builtin', () => {
    const overlay = { source: 'builtin', _customId: 'c1', _customOwnerUserId: 'u2' };
    expect(getPresetSourceKind(overlay, INTRANET)).toBe('shared');
  });
});

// ---------------------------------------------------------------------------
// mergePresets — owner info preservation on builtin overlay
// ---------------------------------------------------------------------------

describe('mergePresets', () => {
  it('preserves owner info when a custom preset overlays a builtin', () => {
    const builtins = [
      { id: 'builtin-1', source: 'builtin', jobName: '용접공', category: '제조업', description: '', modules: { knee: {} } },
    ];
    const customs = [
      {
        id: 'c1', source: 'custom', jobName: '용접공', category: '제조업', description: '',
        revision: 3, visibility: 'organization', ownerUserId: 'u2', ownerName: '홍길동',
        modules: { shoulder: {} },
      },
    ];

    const merged = mergePresets(builtins, customs);
    const overlay = merged.find(p => p.id === 'builtin-1');

    expect(overlay._customOwnerUserId).toBe('u2');
    expect(overlay._customOwnerName).toBe('홍길동');
    expect(overlay._customVisibility).toBe('organization');
    expect(getPresetOwnerName(overlay)).toBe('홍길동');
    expect(getPresetVisibility(overlay)).toBe('organization');
    // and ownership is judged correctly from the merged record
    expect(getPresetSourceKind(overlay, INTRANET)).toBe('shared');
    expect(isOwnPreset(overlay, { mode: 'intranet', user: { id: 'u2' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// saveCustomPreset (intranet) — PATCH body carries visibility
// ---------------------------------------------------------------------------

describe('saveCustomPreset intranet update', () => {
  it('includes visibility in the PATCH body', async () => {
    requestJson.mockResolvedValue({ preset: { id: 'p1', visibility: 'private' } });

    await saveCustomPreset(
      { id: 'p1', revision: 2, jobName: '용접공', category: '제조업', description: '', visibility: 'private', modules: {} },
      {},
      INTRANET,
    );

    expect(requestJson).toHaveBeenCalledWith(
      '/api/presets/p1',
      expect.objectContaining({
        method: 'PATCH',
        body: expect.objectContaining({ visibility: 'private' }),
      }),
    );
  });
});
