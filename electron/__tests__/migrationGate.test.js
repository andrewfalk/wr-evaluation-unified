import { describe, expect, it } from 'vitest';
import { evaluateMigrationGate } from '../migrationGate.js';

const ALLOWED = 'https://wr.hospital.local';

describe('evaluateMigrationGate', () => {
  it('rejects when build target is not intranet', () => {
    const r = evaluateMigrationGate({
      isIntranet: false,
      senderUrl: `${ALLOWED}/`,
      allowedOrigin: ALLOWED,
      accessToken: 't',
    });
    expect(r).toEqual({ allowed: false, reason: 'not_intranet_build' });
  });

  it('rejects when allowedOrigin is empty (misconfiguration)', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: `${ALLOWED}/`,
      allowedOrigin: null,
      accessToken: 't',
    });
    expect(r).toEqual({ allowed: false, reason: 'origin_not_allowed' });
  });

  it('rejects when sender URL origin does not match allowedOrigin', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: 'https://evil.example/',
      allowedOrigin: ALLOWED,
      accessToken: 't',
    });
    expect(r).toEqual({ allowed: false, reason: 'origin_not_allowed' });
  });

  it('rejects when sender URL is malformed', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: 'not a url',
      allowedOrigin: ALLOWED,
      accessToken: 't',
    });
    expect(r).toEqual({ allowed: false, reason: 'origin_not_allowed' });
  });

  it('rejects when access token is missing (pre-login)', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: `${ALLOWED}/login`,
      allowedOrigin: ALLOWED,
      accessToken: null,
    });
    expect(r).toEqual({ allowed: false, reason: 'not_authenticated' });
  });

  it('allows when all four conditions are satisfied', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: `${ALLOWED}/settings`,
      allowedOrigin: ALLOWED,
      accessToken: 'jwt-abc',
    });
    expect(r).toEqual({ allowed: true, reason: null });
  });

  it('matches origin regardless of path or query', () => {
    const r = evaluateMigrationGate({
      isIntranet: true,
      senderUrl: `${ALLOWED}/some/deep/path?x=1#frag`,
      allowedOrigin: ALLOWED,
      accessToken: 't',
    });
    expect(r.allowed).toBe(true);
  });
});
