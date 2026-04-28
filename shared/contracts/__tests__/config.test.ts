import { describe, it, expect } from 'vitest';
import {
  DeploymentModeSchema,
  ServerPublicConfigSchema,
  MockScopedStateSchema,
  MockStoreSchema,
} from '../config';

describe('DeploymentModeSchema', () => {
  it('accepts intranet', () => {
    expect(DeploymentModeSchema.parse('intranet')).toBe('intranet');
  });

  it('accepts standalone', () => {
    expect(DeploymentModeSchema.parse('standalone')).toBe('standalone');
  });

  it('rejects unknown mode', () => {
    expect(() => DeploymentModeSchema.parse('cloud')).toThrow();
  });
});

describe('ServerPublicConfigSchema', () => {
  it('parses intranet config', () => {
    const result = ServerPublicConfigSchema.parse({
      mode: 'intranet',
      aiEnabled: false,
      localFallbackAllowed: false,
      serverTime: '2024-01-10T09:00:00.000Z',
    });
    expect(result.mode).toBe('intranet');
    expect(result.aiEnabled).toBe(false);
    expect(result.localFallbackAllowed).toBe(false);
  });

  it('parses standalone config with AI enabled', () => {
    const result = ServerPublicConfigSchema.parse({
      mode: 'standalone',
      aiEnabled: true,
      localFallbackAllowed: true,
      serverTime: '2024-01-10T09:00:00.000Z',
    });
    expect(result.aiEnabled).toBe(true);
  });

  it('rejects invalid mode', () => {
    expect(() => ServerPublicConfigSchema.parse({
      mode: 'unknown',
      aiEnabled: false,
      localFallbackAllowed: false,
      serverTime: '',
    })).toThrow();
  });

  it('rejects missing serverTime', () => {
    expect(() => ServerPublicConfigSchema.parse({
      mode: 'intranet',
      aiEnabled: false,
      localFallbackAllowed: false,
    })).toThrow();
  });
});

describe('MockScopedStateSchema', () => {
  it('parses valid scoped state', () => {
    const result = MockScopedStateSchema.parse({
      workspaces: [{ id: 'ws-1' }],
      autosave: { savedAt: '2024-01-10T09:00:00.000Z', patients: [] },
      updatedAt: '2024-01-10T09:00:00.000Z',
    });
    expect(result.workspaces).toHaveLength(1);
  });

  it('accepts null autosave', () => {
    const result = MockScopedStateSchema.parse({
      workspaces: [],
      autosave: null,
      updatedAt: '2024-01-10T09:00:00.000Z',
    });
    expect(result.autosave).toBeNull();
  });
});

describe('MockStoreSchema', () => {
  it('parses valid mock store', () => {
    const result = MockStoreSchema.parse({
      version: 1,
      scopes: {
        'org-1:user-1': {
          workspaces: [],
          autosave: null,
          updatedAt: '2024-01-10T09:00:00.000Z',
        },
      },
    });
    expect(result.version).toBe(1);
    expect(result.scopes['org-1:user-1'].autosave).toBeNull();
  });

  it('rejects version other than 1', () => {
    expect(() => MockStoreSchema.parse({
      version: 2,
      scopes: {},
    })).toThrow();
  });

  it('accepts empty scopes', () => {
    expect(MockStoreSchema.parse({ version: 1, scopes: {} }).scopes).toEqual({});
  });
});
