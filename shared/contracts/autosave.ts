import { z } from 'zod';
import { PatientSchema } from './patient';
import { WorkspaceScopeSchema } from './workspace';

// patients is z.unknown() — autosave is a raw payload; client migrates via migratePatientRecords.
export const AutosaveDataSchema = z.object({
  savedAt: z.string(),
  patients: z.array(z.unknown()),
});

export const GetAutosaveResponseSchema = z.union([
  AutosaveDataSchema.extend({
    mock: z.boolean().optional(),
    scope: WorkspaceScopeSchema.optional(),
  }),
  z.null(),
]);

export const PutAutosaveRequestSchema = z.object({
  patients: z.array(PatientSchema),
});

export const PutAutosaveResponseSchema = z.object({
  ok: z.literal(true),
  savedAt: z.string(),
  mock: z.boolean().optional(),
  scope: WorkspaceScopeSchema.optional(),
});

export const DeleteAutosaveResponseSchema = z.object({
  ok: z.literal(true),
  mock: z.boolean().optional(),
  scope: WorkspaceScopeSchema.optional(),
});

export type AutosaveData = z.infer<typeof AutosaveDataSchema>;
export type GetAutosaveResponse = z.infer<typeof GetAutosaveResponseSchema>;
export type PutAutosaveRequest = z.infer<typeof PutAutosaveRequestSchema>;
export type PutAutosaveResponse = z.infer<typeof PutAutosaveResponseSchema>;
export type DeleteAutosaveResponse = z.infer<typeof DeleteAutosaveResponseSchema>;
