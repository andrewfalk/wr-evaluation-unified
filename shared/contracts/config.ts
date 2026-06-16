import { z } from 'zod';

export const DeploymentModeSchema = z.enum(['intranet', 'standalone']);

// Response from GET /api/config/public (no auth required)
export const ServerPublicConfigSchema = z.object({
  mode: DeploymentModeSchema,
  aiEnabled: z.boolean(),
  localFallbackAllowed: z.boolean(),
  // 작업 영상 인간공학 분석(v6.0.0). 구버전 서버 응답 호환 위해 기본 false.
  videoAnalysisEnabled: z.boolean().default(false),
  // dev-only fixture 입력 UI 노출 플래그(PR D1). 서버 경로는 노출하지 않는다. 구버전 호환 기본 false.
  videoAnalysisFixtureMode: z.boolean().default(false),
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
