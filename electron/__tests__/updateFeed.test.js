import { describe, expect, it } from 'vitest';
import {
  resolveUpdateChannel, buildUpdateFeedConfig, shouldCheckForUpdates,
  shouldSkipUpdateCheck, decideUpdatePhaseTransition,
} from '../updateFeed.js';

describe('resolveUpdateChannel', () => {
  it('falls back to latest when unset', () => {
    expect(resolveUpdateChannel(undefined)).toBe('latest');
  });
  it('falls back to latest for an empty string', () => {
    expect(resolveUpdateChannel('')).toBe('latest');
  });
  it('falls back to latest for a typo/unknown value', () => {
    expect(resolveUpdateChannel('cannary')).toBe('latest');
  });
  it('accepts canary', () => {
    expect(resolveUpdateChannel('canary')).toBe('canary');
  });
});

describe('buildUpdateFeedConfig', () => {
  it('returns null for a standalone (non-intranet) build', () => {
    expect(buildUpdateFeedConfig({ isIntranetBuild: false, intranetUrl: 'https://wr.hospital.local:8443' })).toBeNull();
  });

  it('returns null when intranetUrl is falsy', () => {
    expect(buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: '' })).toBeNull();
  });

  it('builds a generic feed config with no channel key for the default channel', () => {
    expect(buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: 'https://wr.hospital.local:8443' })).toEqual({
      provider: 'generic',
      url: 'https://wr.hospital.local:8443/updates',
    });
  });

  it('strips a trailing slash from intranetUrl before joining', () => {
    const result = buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: 'https://wr.hospital.local:8443/' });
    expect(result.url).toBe('https://wr.hospital.local:8443/updates');
  });

  it('strips multiple trailing slashes', () => {
    const result = buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: 'https://wr.hospital.local:8443///' });
    expect(result.url).toBe('https://wr.hospital.local:8443/updates');
  });

  it('includes channel key for canary', () => {
    const result = buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: 'https://wr.hospital.local:8443', channel: 'canary' });
    expect(result).toEqual({ provider: 'generic', url: 'https://wr.hospital.local:8443/updates', channel: 'canary' });
  });

  it('normalizes an unknown channel value to the default (no channel key)', () => {
    const result = buildUpdateFeedConfig({ isIntranetBuild: true, intranetUrl: 'https://wr.hospital.local:8443', channel: 'bogus' });
    expect(result).toEqual({ provider: 'generic', url: 'https://wr.hospital.local:8443/updates' });
  });
});

describe('shouldCheckForUpdates (fail-closed policy gate)', () => {
  it('rejects a null policy', () => {
    expect(shouldCheckForUpdates({ policy: null, channel: 'latest' })).toBe(false);
  });
  it('rejects a non-object policy', () => {
    expect(shouldCheckForUpdates({ policy: 'enabled', channel: 'latest' })).toBe(false);
  });
  it('rejects enabled: false', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: false, channels: ['latest'] }, channel: 'latest' })).toBe(false);
  });
  it('rejects a missing enabled field', () => {
    expect(shouldCheckForUpdates({ policy: { channels: ['latest'] }, channel: 'latest' })).toBe(false);
  });
  it('rejects a missing channels field', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true }, channel: 'latest' })).toBe(false);
  });
  it('rejects channels as a bare string (the exact operator-typo scenario this guards against)', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: 'canary' }, channel: 'canary' })).toBe(false);
  });
  it('rejects an empty channels array', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: [] }, channel: 'latest' })).toBe(false);
  });
  it('rejects a policy containing any unknown channel value', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: ['latest', 'beta'] }, channel: 'latest' })).toBe(false);
  });
  it('allows a canary machine when channels is ["canary"]', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: ['canary'] }, channel: 'canary' })).toBe(true);
  });
  it('rejects a latest machine when channels is ["canary"]', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: ['canary'] }, channel: 'latest' })).toBe(false);
  });
  it('allows a latest machine when channels is ["latest"]', () => {
    expect(shouldCheckForUpdates({ policy: { enabled: true, channels: ['latest'] }, channel: 'latest' })).toBe(true);
  });
});

describe('shouldSkipUpdateCheck', () => {
  it.each(['downloading', 'ready', 'installing'])('skips while phase is %s', (phase) => {
    expect(shouldSkipUpdateCheck(phase)).toBe(true);
  });
  it.each(['idle', 'checking'])('does not skip while phase is %s', (phase) => {
    expect(shouldSkipUpdateCheck(phase)).toBe(false);
  });
});

describe('decideUpdatePhaseTransition', () => {
  it('checking → phase checking, timer untouched', () => {
    expect(decideUpdatePhaseTransition('checking')).toEqual({ phase: 'checking', timerAction: 'none' });
  });
  it('available → phase downloading, timer cleared (no re-check mid-download)', () => {
    expect(decideUpdatePhaseTransition('available')).toEqual({ phase: 'downloading', timerAction: 'clear' });
  });
  it('notAvailable → phase idle, stable interval rescheduled', () => {
    expect(decideUpdatePhaseTransition('notAvailable')).toEqual({ phase: 'idle', timerAction: 'scheduleStable' });
  });
  it('downloaded → phase ready, timer cleared (no re-check once staged)', () => {
    expect(decideUpdatePhaseTransition('downloaded')).toEqual({ phase: 'ready', timerAction: 'clear' });
  });
  it('installStart → phase installing, timer untouched', () => {
    expect(decideUpdatePhaseTransition('installStart')).toEqual({ phase: 'installing', timerAction: 'none' });
  });
  it('installFail → phase ready, no extra backoff scheduled', () => {
    expect(decideUpdatePhaseTransition('installFail')).toEqual({ phase: 'ready', timerAction: 'none' });
  });
  it('throws on an unknown event name', () => {
    expect(() => decideUpdatePhaseTransition('bogus')).toThrow(/unknown update phase event/);
  });
});
