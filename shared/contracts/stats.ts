import { z } from 'zod';

// PR0-A: 통계 워크벤치 권한 계약. 이름을 `capabilities`/`Capabilities`로 짓지 않는다 —
// auth.ts의 CapabilitiesSchema({ aiEnabled, localFallbackAllowed })가 이미 그 이름을
// 배포모드 기능 플래그의 의미로 쓰고 있어 클라이언트 노출 시 혼동을 일으킨다.
export const StatsCapabilityKeySchema = z.enum([
  'stats.view',
  'stats.regression',
  'stats.export_results',
  'stats.export_limited_rows',
  'stats.export_phi',
]);

export const StatsCapabilityDefinitionSchema = z.object({
  key:               StatsCapabilityKeySchema,
  label:             z.string(),
  description:       z.string().nullable(),
  defaultAllRoles:   z.boolean(),
  requiresStepUp:    z.boolean(),
  requiresAdminRole: z.boolean(),
});

export const UserCapabilityGrantStatusSchema = z.enum(['active', 'expired', 'revoked']);

export const UserCapabilityGrantSchema = z.object({
  id:               z.string(),
  userId:           z.string(),
  userName:         z.string(),
  capability:       StatsCapabilityKeySchema,
  grantedBy:        z.string().nullable(),
  grantedByName:    z.string().nullable(),
  grantedAt:        z.string(),
  expiresAt:        z.string().nullable(),
  reason:           z.string(),
  revokedAt:        z.string().nullable(),
  revocationReason: z.string().nullable(),
  status:           UserCapabilityGrantStatusSchema,
});

export const CreateCapabilityGrantRequestSchema = z.object({
  userId:     z.string().uuid(),
  capability: StatsCapabilityKeySchema,
  // trim: 공백만 있는 사유가 grant_revocation_state 등 DB 감사 목적의 "사유"로 저장되면
  // 사실상 빈 값이다. max: reason은 audit_logs.extra(jsonb)에도 실리므로 과도한 길이를 막는다.
  reason:     z.string().trim().min(1).max(500),
  // ISO 8601 문자열만 허용 — 임의 문자열을 받으면 잘못된 날짜가 grant_ttl CHECK 위반으로
  // DB 500이 되거나(§7.2), 파싱 불가능한 값이 조용히 NaN Date로 저장될 수 있다.
  expiresAt:  z.string().datetime({ offset: true }).optional(),
});

export const RevokeCapabilityGrantRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export type StatsCapabilityKey            = z.infer<typeof StatsCapabilityKeySchema>;
export type StatsCapabilityDefinition     = z.infer<typeof StatsCapabilityDefinitionSchema>;
export type UserCapabilityGrantStatus     = z.infer<typeof UserCapabilityGrantStatusSchema>;
export type UserCapabilityGrant           = z.infer<typeof UserCapabilityGrantSchema>;
export type CreateCapabilityGrantRequest  = z.infer<typeof CreateCapabilityGrantRequestSchema>;
export type RevokeCapabilityGrantRequest  = z.infer<typeof RevokeCapabilityGrantRequestSchema>;
