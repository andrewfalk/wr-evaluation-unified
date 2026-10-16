import { z } from 'zod';
import { PatientSchema } from './patient';

export const WorkspaceScopeSchema = z.object({
  scopeKey: z.string(),
  userId: z.string(),
  organizationId: z.string(),
  authMode: z.string(),
});

// patients is z.unknown() because workspaces are snapshots — patient content
// is validated and migrated separately by migratePatientRecords on the client.
// Keeping it unknown prevents stale schema versions from breaking response parsing.
export const WorkspaceItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  count: z.number().int().nonnegative(),
  savedAt: z.string(),
  patients: z.array(z.unknown()),
});

export const GetWorkspacesResponseSchema = z.object({
  items: z.array(WorkspaceItemSchema),
  mock: z.boolean().optional(),
  scope: WorkspaceScopeSchema.optional(),
});

// Request keeps PatientSchema strict — outgoing data must be fully valid.
export const SaveWorkspaceRequestSchema = z.object({
  name: z.string().min(1, 'Workspace name is required'),
  patients: z.array(PatientSchema),
  // 환자별 편집 락 lease token(키 = 클라이언트 로컬 환자 id). X-Lock-Token 헤더는 환자 1명용이라
  // 환자 N명을 싣는 저장에는 쓸 수 없다. 스냅샷(patients) 안에는 절대 넣지 않는다.
  lockTokens: z.record(z.string(), z.string()).optional(),
});

// 워크스페이스 저장이 patient_records에 환자별로 쓴 결과. 스냅샷 목록(items)은 항상 저장되지만 환자 데이터는
// 담당의·revision·편집 락 검사를 통과한 환자만 서버 기록에 반영된다. 구서버·mock 응답에는 없으므로 기본값 [].
export const WorkspaceSaveAckSchema = z.object({
  // assignedDoctorUserId: 쓰기 후 행의 담당의 — 클라이언트 편집 권한 판정이 쓴다. 구서버 응답에는 없다(undefined).
  saved: z.array(z.object({
    id: z.string(),
    revision: z.number().int().positive(),
    assignedDoctorUserId: z.string().nullable().optional(),
  })).default([]),
  skipped: z.array(z.object({ id: z.string(), reason: z.enum(['not_assigned', 'deleted', 'error']) })).default([]),
  conflicts: z.array(z.object({ id: z.string(), serverRevision: z.number().int() })).default([]),
  // holder에는 lease token / 사용자 id가 없다(서버가 holderName·acquiredAt·expiresAt만 내려준다).
  // 저장은 이미 끝난 뒤의 응답이라, 형태가 조금 달라도 파싱 실패(CONTRACT_VIOLATION)로 "저장 실패"처럼 보이지 않게 관대하게 받는다.
  lockedByOther: z.array(z.object({
    id: z.string(),
    holder: z.object({
      holderName: z.string().nullable().optional(),
      acquiredAt: z.string().nullable().optional(),
      expiresAt: z.string().nullable().optional(),
    }).passthrough(),
  })).default([]),
});

export const SaveWorkspaceResponseSchema = GetWorkspacesResponseSchema.merge(WorkspaceSaveAckSchema);
export const DeleteWorkspaceResponseSchema = GetWorkspacesResponseSchema;

export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
export type WorkspaceItem = z.infer<typeof WorkspaceItemSchema>;
export type GetWorkspacesResponse = z.infer<typeof GetWorkspacesResponseSchema>;
export type SaveWorkspaceRequest = z.infer<typeof SaveWorkspaceRequestSchema>;
export type SaveWorkspaceResponse = z.infer<typeof SaveWorkspaceResponseSchema>;
export type WorkspaceSaveAck = z.infer<typeof WorkspaceSaveAckSchema>;
export type DeleteWorkspaceResponse = z.infer<typeof DeleteWorkspaceResponseSchema>;
