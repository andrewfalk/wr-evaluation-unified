import { z } from 'zod';

export const DeploymentModeSchema = z.enum(['intranet', 'standalone']);

// Response from GET /api/config/public (no auth required)
export const ServerPublicConfigSchema = z.object({
  mode: DeploymentModeSchema,
  aiEnabled: z.boolean(),
  localFallbackAllowed: z.boolean(),
  serverTime: z.string(),
});

// Mock file-store structure (used by mock-intranet-server)
export const MockScopedStateSchema = z.object({
  workspaces: z.array(z.unknown()),
  autosave: z.unknown().nullable(),
  updatedAt: z.string(),
});

export const MockStoreSchema = z.object({
  version: z.literal(1),
  scopes: z.record(z.string(), MockScopedStateSchema),
});

export type DeploymentMode = z.infer<typeof DeploymentModeSchema>;
export type ServerPublicConfig = z.infer<typeof ServerPublicConfigSchema>;
export type MockScopedState = z.infer<typeof MockScopedStateSchema>;
export type MockStore = z.infer<typeof MockStoreSchema>;
