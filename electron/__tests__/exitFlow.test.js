import { describe, expect, it, vi } from 'vitest';
import { decideExitAction, decideUpdatePromptAction, withExitFlowMutex, installAfterLogout } from '../exitFlow.js';

describe('decideExitAction', () => {
  it('proceeds immediately when there is no unsaved draft', () => {
    expect(decideExitAction({ hasUnsavedDraft: false, exitFlowInFlight: false })).toBe('proceed');
  });

  it('requires confirmation when a draft is unsaved', () => {
    expect(decideExitAction({ hasUnsavedDraft: true, exitFlowInFlight: false })).toBe('confirm');
  });

  it('ignores a second trigger while a confirm dialog is already in flight', () => {
    expect(decideExitAction({ hasUnsavedDraft: true, exitFlowInFlight: true })).toBe('ignore');
  });

  it('ignores a second trigger even if hasUnsavedDraft flips false mid-flight', () => {
    // exitFlowInFlight takes priority so a stale/racing dirty-flag update can't
    // spawn a duplicate dialog while the first one is still open.
    expect(decideExitAction({ hasUnsavedDraft: false, exitFlowInFlight: true })).toBe('ignore');
  });
});

describe('decideUpdatePromptAction', () => {
  it('prompts when nothing else is in flight', () => {
    expect(decideUpdatePromptAction({ exitFlowInFlight: false })).toBe('prompt');
  });

  it('ignores while a close/reload/install prompt is already in flight', () => {
    expect(decideUpdatePromptAction({ exitFlowInFlight: true })).toBe('ignore');
  });
});

describe('withExitFlowMutex', () => {
  it('releases the mutex after showDialog resolves true', async () => {
    const calls = [];
    const setInFlight = (v) => calls.push(v);
    const result = await withExitFlowMutex(() => Promise.resolve(true), setInFlight);
    expect(result).toBe(true);
    expect(calls).toEqual([true, false]);
  });

  it('releases the mutex after showDialog resolves false (cancel)', async () => {
    const calls = [];
    const setInFlight = (v) => calls.push(v);
    const result = await withExitFlowMutex(() => Promise.resolve(false), setInFlight);
    expect(result).toBe(false);
    expect(calls).toEqual([true, false]);
  });

  it('releases the mutex even when showDialog rejects', async () => {
    const calls = [];
    const setInFlight = (v) => calls.push(v);
    await expect(withExitFlowMutex(() => Promise.reject(new Error('boom')), setInFlight)).rejects.toThrow('boom');
    expect(calls).toEqual([true, false]);
  });

  it('releases the mutex even when showDialog throws synchronously (regression for the finally-skip bug)', async () => {
    const calls = [];
    const setInFlight = (v) => calls.push(v);
    const throwing = () => { throw new Error('sync boom'); };
    await expect(withExitFlowMutex(throwing, setInFlight)).rejects.toThrow('sync boom');
    expect(calls).toEqual([true, false]);
  });
});

describe('installAfterLogout', () => {
  it('does not call install before the logout promise resolves', async () => {
    const install = vi.fn();
    let resolveLogout;
    const logoutPromise = new Promise((resolve) => { resolveLogout = resolve; });

    const resultPromise = installAfterLogout(logoutPromise, install);
    // Give any queued microtasks a chance to run — install must still be unfired.
    await Promise.resolve();
    await Promise.resolve();
    expect(install).not.toHaveBeenCalled();

    resolveLogout();
    await resultPromise;
    expect(install).toHaveBeenCalledTimes(1);
  });
});
