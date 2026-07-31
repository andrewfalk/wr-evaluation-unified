// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useSyncStatusSummary } from '../useSyncStatusSummary.js';

function patient(overrides = {}) {
  return { id: 'p1', data: { shared: {}, modules: {}, activeModules: [] }, sync: {}, ...overrides };
}

describe('useSyncStatusSummary', () => {
  it('counts each issue kind independently (multiple badges, not a single winner)', () => {
    const patients = [
      patient({ id: 'a', sync: { syncStatus: 'conflict', conflict: { kind: 'push' } } }),
      patient({ id: 'b', sync: { syncStatus: 'conflict', conflict: { kind: 'lock' } } }),
      patient({ id: 'c', sync: { syncStatus: 'dirty' } }),
      patient({ id: 'd', sync: { syncStatus: 'local-only' } }),
      patient({ id: 'e', sync: { syncStatus: 'synced' } }),
    ];

    const { result } = renderHook(() => useSyncStatusSummary(patients, { status: 'idle' }));

    expect(result.current).toEqual({
      conflictCount: 1,
      lockLostCount: 1,
      pendingCount: 2,
      offline: false,
    });
  });

  it('ignores redacted workspace snapshot stubs', () => {
    const patients = [
      { id: 'r1', redacted: true, sync: { syncStatus: 'conflict' } },
    ];
    const { result } = renderHook(() => useSyncStatusSummary(patients, {}));
    expect(result.current.conflictCount).toBe(0);
  });

  it('reports offline true only when syncState.status is error', () => {
    const { result: idle } = renderHook(() => useSyncStatusSummary([], { status: 'idle' }));
    expect(idle.current.offline).toBe(false);

    const { result: erroring } = renderHook(() => useSyncStatusSummary([], { status: 'error' }));
    expect(erroring.current.offline).toBe(true);
  });

  it('returns all zeros for an empty patient list', () => {
    const { result } = renderHook(() => useSyncStatusSummary([], {}));
    expect(result.current).toEqual({ conflictCount: 0, lockLostCount: 0, pendingCount: 0, offline: false });
  });
});
