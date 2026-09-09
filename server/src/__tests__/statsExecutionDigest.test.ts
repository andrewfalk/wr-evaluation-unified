import { describe, expect, it } from 'vitest';
import { computeExecutionDigest } from '../statsExecutionDigest';

const base = {
  organizationId: 'org-1',
  requestedBy: 'user-1',
  recipeDigest: 'recipe-digest-1',
  sourceDigest: 'source-digest-1',
};

describe('computeExecutionDigest', () => {
  it('is deterministic for the same input', () => {
    expect(computeExecutionDigest(base)).toBe(computeExecutionDigest({ ...base }));
  });

  it('changes when organizationId changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, organizationId: 'org-2' }));
  });

  it('changes when requestedBy changes (v1: no cross-user cache sharing)', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, requestedBy: 'user-2' }));
  });

  it('changes when recipeDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, recipeDigest: 'recipe-digest-2' }));
  });

  it('changes when sourceDigest changes', () => {
    expect(computeExecutionDigest(base)).not.toBe(computeExecutionDigest({ ...base, sourceDigest: 'source-digest-2' }));
  });
});
