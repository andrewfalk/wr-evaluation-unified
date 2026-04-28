import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDeviceId } from '../storage.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeMockStorage() {
  const store = {};
  return {
    getItem: k => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: k => { delete store[k]; },
    _store: store,
  };
}

describe('getDeviceId', () => {
  let mock;

  beforeEach(() => {
    mock = makeMockStorage();
    globalThis.localStorage = mock;
  });

  afterEach(() => {
    delete globalThis.localStorage;
  });

  it('generates a valid UUID on first call', () => {
    const id = getDeviceId();
    expect(id).toMatch(UUID_RE);
  });

  it('persists the generated ID to localStorage', () => {
    const id = getDeviceId();
    expect(mock.getItem('wrEvalUnifiedDeviceId')).toBe(id);
  });

  it('returns the same ID on subsequent calls', () => {
    const first = getDeviceId();
    const second = getDeviceId();
    expect(second).toBe(first);
  });

  it('reuses an existing valid UUID already in storage', () => {
    const preset = '11111111-2222-3333-4444-555555555555';
    mock.setItem('wrEvalUnifiedDeviceId', preset);
    expect(getDeviceId()).toBe(preset);
  });

  it('replaces a corrupted (non-UUID) stored value with a fresh UUID', () => {
    mock.setItem('wrEvalUnifiedDeviceId', 'abc');
    const id = getDeviceId();
    expect(id).toMatch(UUID_RE);
    expect(id).not.toBe('abc');
    expect(mock.getItem('wrEvalUnifiedDeviceId')).toBe(id);
  });

  it('returns a transient UUID when localStorage is unavailable', () => {
    delete globalThis.localStorage;
    const id = getDeviceId();
    expect(id).toMatch(UUID_RE);
  });

  it('returns a transient UUID when localStorage throws', () => {
    globalThis.localStorage = {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    };
    const id = getDeviceId();
    expect(id).toMatch(UUID_RE);
  });
});
