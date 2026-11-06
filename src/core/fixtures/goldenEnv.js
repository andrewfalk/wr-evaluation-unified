// Shared setup for golden (characterization) tests — REFACTORING_ROADMAP P0-9.
//
// Golden tests freeze the CURRENT output of the app's pure functions in files under __goldens__/.
// A refactor must not change them; if a test fails, behaviour changed. Only an intended output
// change (a feature PR) updates a golden: `npx vitest run -u <test file>`, and the PR explains the
// diff. Never update goldens in a refactoring PR.
//
// Everything that is not part of the input must be pinned so the output is the same on any PC:
//   - time zone: Asia/Seoul, set by vitest.config.js before workers start (checked here);
//   - default-locale number formatting: `n.toLocaleString()` without a locale is pinned to ko-KR
//     (an explicit locale is honoured);
//   - random ids and the clock: Date.now / Math.random / crypto.randomUUID return fixed sequences.
import { expect, vi } from 'vitest';

export function useGoldenEnvironment() {
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone,
    'golden tests need TZ=Asia/Seoul (set in vitest.config.js)').toBe('Asia/Seoul');

  const original = Number.prototype.toLocaleString;
  vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function toLocaleString(locales, options) {
    return original.call(this, locales ?? 'ko-KR', options);
  });

  // Both Date.now() and `new Date()` (e.g. createdAt stamps) read this fixed clock.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  let seed = 1;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  });
  let n = 0;
  vi.spyOn(globalThis.crypto, 'randomUUID').mockImplementation(
    () => `ffffffff-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  );
}
