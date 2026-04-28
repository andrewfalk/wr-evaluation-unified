import { z } from 'zod';

export const UserSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  role: z.string(),          // 'clinician' | 'admin' | ...
  organizationId: z.string(),
  authProvider: z.string(),  // 'local-fallback' | 'local-db' | ...
});

export const OrgSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const CapabilitiesSchema = z.object({
  aiEnabled: z.boolean(),
  localFallbackAllowed: z.boolean(),
});

export const LoginRequestSchema = z.object({
  loginId: z.string().min(1),
  password: z.string().min(1),
});

export const LoginResponseSchema = z.object({
  user: UserSchema,
  accessToken: z.string(),
  accessExpiresAt: z.string(),
});

export const MeResponseSchema = z.object({
  user: UserSchema,
  org: OrgSchema,
  capabilities: CapabilitiesSchema,
});

export const SessionSchema = z.object({
  version: z.number().int(),
  mode: z.enum(['local', 'intranet']),
  status: z.enum(['ready', 'loading', 'error']),
  accessToken: z.string().nullable(),
  apiBaseUrl: z.string(),
  refreshedAt: z.string(),
  user: UserSchema,
});

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(10, 'Password must be at least 10 characters'),
});

export type User = z.infer<typeof UserSchema>;
export type Org = z.infer<typeof OrgSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type MeResponse = z.infer<typeof MeResponseSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;
