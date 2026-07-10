import { describe, expect, it } from 'vitest';
import { getDefaultPatientScope, normalizePatientScopeForSession, getValidPatientScopes } from '../patientScope';

function makeSession({ mode = 'intranet', role = 'doctor' } = {}) {
  return { mode, user: { role } };
}

describe('getDefaultPatientScope', () => {
  it('returns "mine" for a doctor in intranet mode', () => {
    expect(getDefaultPatientScope(makeSession({ role: 'doctor' }))).toBe('mine');
  });

  it('returns "all" for a non-doctor (admin) in intranet mode', () => {
    expect(getDefaultPatientScope(makeSession({ role: 'admin' }))).toBe('all');
  });

  it('returns "mine" for local (non-intranet) sessions regardless of role', () => {
    expect(getDefaultPatientScope(makeSession({ mode: 'local', role: 'admin' }))).toBe('mine');
  });
});

describe('normalizePatientScopeForSession', () => {
  it('passes "all" and "__unassigned__" through unchanged', () => {
    const session = makeSession({ role: 'admin' });
    expect(normalizePatientScopeForSession(session, 'all')).toBe('all');
    expect(normalizePatientScopeForSession(session, '__unassigned__')).toBe('__unassigned__');
  });

  it('keeps "mine" for a doctor', () => {
    expect(normalizePatientScopeForSession(makeSession({ role: 'doctor' }), 'mine')).toBe('mine');
  });

  it('converts "mine" to "all" for admin (no "my patients" concept)', () => {
    expect(normalizePatientScopeForSession(makeSession({ role: 'admin' }), 'mine')).toBe('all');
  });

  it('passes a specific doctor userId through untouched (server re-validates)', () => {
    const session = makeSession({ role: 'admin' });
    expect(normalizePatientScopeForSession(session, 'doctor-uuid-123')).toBe('doctor-uuid-123');
  });

  it('falls back to "all" for empty/non-string scope', () => {
    const session = makeSession({ role: 'doctor' });
    expect(normalizePatientScopeForSession(session, '')).toBe('all');
    expect(normalizePatientScopeForSession(session, null)).toBe('all');
    expect(normalizePatientScopeForSession(session, undefined)).toBe('all');
  });
});

describe('getValidPatientScopes', () => {
  const roster = {
    doctors: [{ userId: 'doc-a', name: 'A', count: 3 }, { userId: 'doc-b', name: 'B', count: 1 }],
    unassignedCount: 2,
  };

  it('always includes "all" and each roster doctor userId', () => {
    const valid = getValidPatientScopes(roster, { canUseMineScope: false });
    expect(valid.has('all')).toBe(true);
    expect(valid.has('doc-a')).toBe(true);
    expect(valid.has('doc-b')).toBe(true);
  });

  it('includes "mine" only when canUseMineScope is true', () => {
    expect(getValidPatientScopes(roster, { canUseMineScope: true }).has('mine')).toBe(true);
    expect(getValidPatientScopes(roster, { canUseMineScope: false }).has('mine')).toBe(false);
  });

  it('includes "__unassigned__" only when unassignedCount > 0', () => {
    expect(getValidPatientScopes(roster, {}).has('__unassigned__')).toBe(true);
    const noUnassigned = { doctors: roster.doctors, unassignedCount: 0 };
    expect(getValidPatientScopes(noUnassigned, {}).has('__unassigned__')).toBe(false);
  });

  it('treats a normal empty roster (ready, no patients) as having no doctor/unassigned scopes', () => {
    const empty = { doctors: [], unassignedCount: 0 };
    const valid = getValidPatientScopes(empty, { canUseMineScope: true });
    expect([...valid]).toEqual(['all', 'mine']);
  });

  it('is defensive against malformed roster input', () => {
    expect([...getValidPatientScopes(null, {})]).toEqual(['all']);
    expect([...getValidPatientScopes(undefined, {})]).toEqual(['all']);
    expect([...getValidPatientScopes({}, {})]).toEqual(['all']);
  });
});
