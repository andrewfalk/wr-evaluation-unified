// createKeyedLimiter (SEC-A L3).
import { describe, expect, it } from 'vitest';
import { createKeyedLimiter } from '../rateLimit';

describe('createKeyedLimiter', () => {
  it('allows max events per key per window, then refuses with the seconds left', () => {
    let t = 1_000_000;
    const limiter = createKeyedLimiter({ windowMs: 60_000, max: 2, now: () => t });
    expect(limiter.hit('a')).toEqual({ allowed: true, retryAfterSec: 60 });
    expect(limiter.hit('a').allowed).toBe(true);
    t += 15_000;
    expect(limiter.hit('a')).toEqual({ allowed: false, retryAfterSec: 45 });
    expect(limiter.hit('b').allowed).toBe(true); // separate bucket per key
  });

  it('starts a new window after windowMs', () => {
    let t = 0;
    const limiter = createKeyedLimiter({ windowMs: 1_000, max: 1, now: () => t });
    expect(limiter.hit('a').allowed).toBe(true);
    expect(limiter.hit('a').allowed).toBe(false);
    t += 1_000;
    expect(limiter.hit('a').allowed).toBe(true);
  });

  it('keeps at most maxKeys windows (expired ones first, then the oldest)', () => {
    let t = 0;
    const limiter = createKeyedLimiter({ windowMs: 1_000, max: 1, maxKeys: 2, now: () => t });
    limiter.hit('a'); limiter.hit('b');
    limiter.hit('c'); // map full, nothing expired → oldest ('a') is dropped
    expect(limiter.hit('a').allowed).toBe(true); // 'a' starts over
    t += 1_000;
    for (let i = 0; i < 100; i += 1) limiter.hit(`k${i}`);
    expect(limiter.hit('k99').allowed).toBe(false); // still counting the newest key
  });
});
