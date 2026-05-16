import { describe, expect, it } from 'vitest';
import { isStale, computeSummary } from '../index.js';

// Pin a reference "now" so tests are deterministic.
const NOW = new Date('2026-05-15T03:00:00Z').getTime();
const H   = 3_600_000; // 1 hour in ms

describe('isStale', () => {
  it('returns true when lastSuccessAt is null', () => {
    expect(isStale(null, NOW, 36)).toBe(true);
  });

  it('returns true when lastSuccessAt is undefined', () => {
    expect(isStale(undefined, NOW, 36)).toBe(true);
  });

  it('returns true when lastSuccessAt is empty string', () => {
    expect(isStale('', NOW, 36)).toBe(true);
  });

  it('returns false when backup ran 35 h ago (within threshold)', () => {
    const lastSuccessAt = new Date(NOW - 35 * H).toISOString();
    expect(isStale(lastSuccessAt, NOW, 36)).toBe(false);
  });

  it('returns false at exactly 36 h (boundary is exclusive)', () => {
    const lastSuccessAt = new Date(NOW - 36 * H).toISOString();
    expect(isStale(lastSuccessAt, NOW, 36)).toBe(false);
  });

  it('returns true when backup ran 37 h ago (exceeds threshold)', () => {
    const lastSuccessAt = new Date(NOW - 37 * H).toISOString();
    expect(isStale(lastSuccessAt, NOW, 36)).toBe(true);
  });

  it('respects a custom thresholdHours', () => {
    const lastSuccessAt = new Date(NOW - 25 * H).toISOString();
    expect(isStale(lastSuccessAt, NOW, 24)).toBe(true);
    expect(isStale(lastSuccessAt, NOW, 48)).toBe(false);
  });

  it('uses Date.now() when nowMs is omitted (smoke test)', () => {
    const justNow = new Date().toISOString();
    expect(isStale(justNow, undefined, 36)).toBe(false);
  });

  it('returns true (fail-closed) when lastSuccessAt is a corrupt/invalid date string', () => {
    expect(isStale('not-a-date',  NOW, 36)).toBe(true);
    expect(isStale('2026-99-99',  NOW, 36)).toBe(true);
    expect(isStale('0',           NOW, 36)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeSummary
// ---------------------------------------------------------------------------
describe('computeSummary', () => {
  it('returns "ok" when not stale and no alerts', () => {
    expect(computeSummary(false, 0, 0)).toBe('ok');
  });

  it('returns "stale" when stale but no real alerts', () => {
    expect(computeSummary(true, 0, 0)).toBe('stale');
  });

  it('returns "alert_open" when not stale but real alert exists', () => {
    expect(computeSummary(false, 1, 1)).toBe('alert_open');
  });

  it('returns "stale_and_alert" when stale and real alert exists', () => {
    expect(computeSummary(true, 1, 1)).toBe('stale_and_alert');
  });

  it('returns "dry_run_alert_open" when only dry-run alerts are open (not stale)', () => {
    // realAlertCount=0 but totalAlertCount=1 → step14 verification alert, not an emergency
    expect(computeSummary(false, 0, 1)).toBe('dry_run_alert_open');
  });

  it('returns "stale" (not dry_run_alert_open) when stale + only dry-run alerts', () => {
    // Staleness takes priority; dry-run alert does not escalate to stale_and_alert
    expect(computeSummary(true, 0, 1)).toBe('stale');
  });

  it('returns "stale_and_alert" when real alert exists regardless of dry-run alerts', () => {
    expect(computeSummary(true, 2, 5)).toBe('stale_and_alert');
  });
});
