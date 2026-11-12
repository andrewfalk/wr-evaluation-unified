// Patient request schemas, row shape and the selected columns.
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import { z } from 'zod';
import { CompletionReportFields, requireCompletionVersions } from '../../completionTracking';

// ---------------------------------------------------------------------------
// Schemas — defined locally, mirroring shared/contracts/patient.ts structure
// without a hard runtime dependency on the built contracts package.
// ---------------------------------------------------------------------------

export const CreateBody = z.object({
  id:        z.string().uuid().optional(),
  phase:     z.enum(['intake', 'evaluation']).default('intake'),
  createdAt: z.string().optional(),
  data: z.object({
    shared:        z.record(z.string(), z.unknown()),
    modules:       z.record(z.string(), z.unknown()).default({}),
    activeModules: z.array(z.string()).default([]),
  }),
  ...CompletionReportFields,
}).superRefine(requireCompletionVersions);

export const PatchBody = z.object({
  phase: z.enum(['intake', 'evaluation']).optional(),
  data: z.object({
    shared:        z.record(z.string(), z.unknown()),
    modules:       z.record(z.string(), z.unknown()),
    activeModules: z.array(z.string()),
  }).optional(),
  ...CompletionReportFields,
}).superRefine(requireCompletionVersions);

// ---------------------------------------------------------------------------
// DB row interface
// ---------------------------------------------------------------------------

// PatientRow and SELECT_COLS moved to db/patientRecordsRepo.ts (S7-3); re-exported.
export { type PatientRow, SELECT_COLS } from '../../db/patientRecordsRepo';

// Moved to db/pgErrors.ts (S7-3); re-exported.
export type { PgErrorLike } from '../../db/pgErrors';
