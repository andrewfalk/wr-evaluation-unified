import { describe, it, expect } from 'vitest';
import {
  UserSchema,
  OrgSchema,
  CapabilitiesSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  MeResponseSchema,
  SessionSchema,
  ChangePasswordRequestSchema,
} from '../auth';

const validUser = {
  id: 'user-1',
  displayName: '김호길',
  email: 'dr.kim@hospital.local',
  role: 'clinician',
  organizationId: 'org-1',
  authProvider: 'local-db',
};

const validOrg = { id: 'org-1', name: '근로복지공단 안산병원' };

const validCapabilities = { aiEnabled: false, localFallbackAllowed: false };

describe('UserSchema', () => {
  it('parses valid user', () => {
    expect(UserSchema.parse(validUser)).toMatchObject(validUser);
  });

  it('rejects missing email', () => {
    const { email: _, ...without } = validUser;
    expect(() => UserSchema.parse(without)).toThrow();
  });
});

describe('OrgSchema', () => {
  it('parses valid org', () => {
    expect(OrgSchema.parse(validOrg)).toMatchObject(validOrg);
  });
});

describe('CapabilitiesSchema', () => {
  it('parses all-false capabilities', () => {
    expect(CapabilitiesSchema.parse(validCapabilities)).toMatchObject(validCapabilities);
  });

  it('parses all-true capabilities', () => {
    expect(CapabilitiesSchema.parse({ aiEnabled: true, localFallbackAllowed: true }).aiEnabled).toBe(true);
  });
});

describe('LoginRequestSchema', () => {
  it('parses valid login request', () => {
    const result = LoginRequestSchema.parse({ loginId: 'dr.kim', password: 'secret1234' });
    expect(result.loginId).toBe('dr.kim');
  });

  it('rejects empty loginId', () => {
    expect(() => LoginRequestSchema.parse({ loginId: '', password: 'secret1234' })).toThrow();
  });

  it('rejects empty password', () => {
    expect(() => LoginRequestSchema.parse({ loginId: 'dr.kim', password: '' })).toThrow();
  });
});

describe('LoginResponseSchema', () => {
  it('parses valid login response', () => {
    const result = LoginResponseSchema.parse({
      user: validUser,
      accessToken: 'eyJ...',
      accessExpiresAt: '2024-01-10T10:00:00.000Z',
    });
    expect(result.accessToken).toBe('eyJ...');
    expect(result.user.role).toBe('clinician');
  });
});

describe('MeResponseSchema', () => {
  it('parses valid me response', () => {
    const result = MeResponseSchema.parse({
      user: validUser,
      org: validOrg,
      capabilities: validCapabilities,
    });
    expect(result.org.name).toBe('근로복지공단 안산병원');
    expect(result.capabilities.aiEnabled).toBe(false);
  });
});

describe('SessionSchema', () => {
  it('parses intranet ready session', () => {
    const result = SessionSchema.parse({
      version: 1,
      mode: 'intranet',
      status: 'ready',
      accessToken: 'eyJ...',
      apiBaseUrl: 'https://wr.hospital.local',
      refreshedAt: '2024-01-10T09:00:00.000Z',
      user: validUser,
    });
    expect(result.mode).toBe('intranet');
    expect(result.status).toBe('ready');
  });

  it('accepts null accessToken', () => {
    const result = SessionSchema.parse({
      version: 1,
      mode: 'local',
      status: 'loading',
      accessToken: null,
      apiBaseUrl: '',
      refreshedAt: '2024-01-10T09:00:00.000Z',
      user: validUser,
    });
    expect(result.accessToken).toBeNull();
  });

  it('rejects invalid mode', () => {
    expect(() => SessionSchema.parse({
      version: 1, mode: 'cloud', status: 'ready', accessToken: null,
      apiBaseUrl: '', refreshedAt: '', user: validUser,
    })).toThrow();
  });

  it('rejects invalid status', () => {
    expect(() => SessionSchema.parse({
      version: 1, mode: 'local', status: 'unknown', accessToken: null,
      apiBaseUrl: '', refreshedAt: '', user: validUser,
    })).toThrow();
  });
});

describe('ChangePasswordRequestSchema', () => {
  it('parses valid change password request', () => {
    const result = ChangePasswordRequestSchema.parse({
      currentPassword: 'oldpass',
      newPassword: 'newpassword123',
    });
    expect(result.newPassword).toBe('newpassword123');
  });

  it('rejects new password shorter than 10 chars', () => {
    expect(() => ChangePasswordRequestSchema.parse({
      currentPassword: 'oldpass',
      newPassword: 'short',
    })).toThrow();
  });

  it('rejects empty currentPassword', () => {
    expect(() => ChangePasswordRequestSchema.parse({
      currentPassword: '',
      newPassword: 'newpassword123',
    })).toThrow();
  });
});
