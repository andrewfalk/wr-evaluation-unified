import { describe, expect, it } from 'vitest';
import { decideExitAction } from '../exitFlow.js';

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
