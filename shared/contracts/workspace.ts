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
});

export const SaveWorkspaceResponseSchema = GetWorkspacesResponseSchema;
export const DeleteWorkspaceResponseSchema = GetWorkspacesResponseSchema;

export type WorkspaceScope = z.infer<typeof WorkspaceScopeSchema>;
export type WorkspaceItem = z.infer<typeof WorkspaceItemSchema>;
export type GetWorkspacesResponse = z.infer<typeof GetWorkspacesResponseSchema>;
export type SaveWorkspaceRequest = z.infer<typeof SaveWorkspaceRequestSchema>;
export type SaveWorkspaceResponse = z.infer<typeof SaveWorkspaceResponseSchema>;
export type DeleteWorkspaceResponse = z.infer<typeof DeleteWorkspaceResponseSchema>;
