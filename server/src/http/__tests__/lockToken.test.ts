// http/lockToken.ts (REFACTORING_ROADMAP S4 / P1-18).
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { makeRouterApp } from '../../testing/app';
import { lockOf, lockTokenOf, parsePositiveInt, requireLockToken } from '../lockToken';

describe('parsePositiveInt', () => {
  it.each([
    ['1', 1], ['42', 42], [' 7 ', 7], [3, 3],
  ])('%j → %j', (input, expected) => {
    expect(parsePositiveInt(input)).toBe(expected);
  });

  it.each(['0', '-1', '1abc', '', '1.5', 'abc', undefined, null])('%j → null', (input) => {
    expect(parsePositiveInt(input)).toBeNull();
  });
});

describe('lockTokenOf', () => {
  it('returns the X-Lock-Token header, or null when absent or empty', () => {
    expect(lockTokenOf({ headers: { 'x-lock-token': 'tok' } } as unknown as Request)).toBe('tok');
    expect(lockTokenOf({ headers: { 'x-lock-token': '' } } as unknown as Request)).toBeNull();
    expect(lockTokenOf({ headers: {} } as unknown as Request)).toBeNull();
  });
});

describe('requireLockToken', () => {
  const app = makeRouterApp((a) => {
    a.patch('/x', requireLockToken(), (req, res) => { res.json(lockOf(req)); });
  });

  it('sets req.lock from If-Match and X-Lock-Token', async () => {
    const res = await request(app).patch('/x').set('If-Match', '3').set('X-Lock-Token', 'lease-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ifMatch: 3, token: 'lease-1' });
  });

  it('token is null without X-Lock-Token (the lock gate decides whether one is needed)', async () => {
    expect((await request(app).patch('/x').set('If-Match', '1')).body).toEqual({ ifMatch: 1, token: null });
  });

  it('400 IF_MATCH_REQUIRED without If-Match', async () => {
    const res = await request(app).patch('/x');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'IF_MATCH_REQUIRED', error: 'If-Match header with current revision is required' });
  });

  it.each(['0', '-2', 'abc', '1.5', 'W/"1"'])('400 INVALID_IF_MATCH for If-Match %j', async (value) => {
    const res = await request(app).patch('/x').set('If-Match', value);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ code: 'INVALID_IF_MATCH', error: 'If-Match must be a positive integer revision' });
  });

  it('lockOf without the middleware throws the same 400 (fail-closed)', () => {
    let caught: unknown;
    try { lockOf({} as Request); } catch (err) { caught = err; }
    expect(caught).toMatchObject({ status: 400, code: 'IF_MATCH_REQUIRED' });
  });
});
