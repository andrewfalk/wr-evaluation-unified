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

export interface PatientRow {
  id:                      string;
  organization_id:         string;
  patient_person_id:       string;
  owner_user_id:           string;
  assigned_doctor_user_id: string | null;
  name:                    string;
  patient_no:              string | null;
  birth_date:              string | null;
  injury_date:             string | null;
  evaluation_date:         string | null;
  active_modules:          string[];
  diagnoses_codes:         string[];
  jobs_names:              string[];
  revision:                number;
  created_at:              Date;
  updated_at:              Date;
  payload:                 unknown;
  completion_status:                    string;
  server_observed_modules_complete_at:  Date | null;
  completion_source:                    string | null;
  completion_client_build_version:      string | null;
  completion_client_schema_version:     number | null;
  server_verified_modules_complete_at:    Date | null;
  completion_verification_engine_version: string | null;
}

export const SELECT_COLS = `
  id, organization_id, patient_person_id, owner_user_id, assigned_doctor_user_id,
  name, patient_no, birth_date, injury_date, evaluation_date, active_modules,
  diagnoses_codes, jobs_names, revision, created_at, updated_at, payload,
  completion_status, server_observed_modules_complete_at, completion_source,
  completion_client_build_version, completion_client_schema_version,
  server_verified_modules_complete_at, completion_verification_engine_version`;

export interface PgErrorLike {
  code?:       string;
  constraint?: string;
}
