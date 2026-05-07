import { z } from 'zod';

export const DiagnosisSchema = z.object({
  id: z.string().uuid(),
  code: z.string(),
  name: z.string(),
  side: z.string(),
}).passthrough(); // module-specific fields (confirmedRight, assessmentRight, etc.)

export const SharedJobSchema = z.object({
  id: z.string().uuid(),
  jobName: z.string(),
  presetId: z.string().nullable(),
  startDate: z.string(),
  endDate: z.string(),
  workPeriodOverride: z.string(),
  workDaysPerYear: z.number().int().nonnegative().default(250),
});

export const SharedDataSchema = z.object({
  patientNo: z.string(),
  name: z.string(),
  gender: z.string(),
  height: z.string(),
  weight: z.string(),
  birthDate: z.string(),
  injuryDate: z.string(),
  hospitalName: z.string(),
  department: z.string(),
  doctorName: z.string(),
  evaluationDate: z.string(),
  medicalRecord: z.string(),
  highBloodPressure: z.string(),
  diabetes: z.string(),
  visitHistory: z.string(),
  consultReplyOrtho: z.string(),
  consultReplyNeuro: z.string(),
  consultReplyRehab: z.string(),
  consultReplyOther: z.string(),
  specialNotes: z.string(),
  diagnoses: z.array(DiagnosisSchema),
  jobs: z.array(SharedJobSchema),
});

export const PatientDataSchema = z.object({
  shared: SharedDataSchema,
  modules: z.record(z.string(), z.unknown()),
  activeModules: z.array(z.string()),
});

export const PatientSyncConflictSchema = z.object({
  kind: z.string(),
  serverPatient: z.unknown().optional(),
  serverRevision: z.number().int().nullable().optional(),
}).passthrough();

export const PatientSyncWarningSchema = z.object({
  code: z.string(),
  message: z.string(),
  existingName: z.string().optional(),
  incomingName: z.string().optional(),
}).passthrough();

// Matches patientRecords.js DEFAULT_PATIENT_SYNC
export const PatientSyncSchema = z.object({
  serverId: z.string().nullable(),
  revision: z.number().int(),
  syncStatus: z.enum(['local-only', 'dirty', 'synced', 'conflict']),
  lastSyncedAt: z.string().nullable(),
  conflict: PatientSyncConflictSchema.optional(),
  warnings: z.array(PatientSyncWarningSchema).optional(),
});

// Matches patientRecords.js createPatientMeta()
export const PatientMetaSchema = z.object({
  organizationId: z.string().nullable(),
  ownerUserId: z.string().nullable(),
  createdBy: z.string().nullable(),
  updatedBy: z.string().nullable(),
  authMode: z.string(),
  source: z.string(),
});

export const PatientSchema = z.object({
  id: z.string().uuid(),
  createdAt: z.string(),
  phase: z.enum(['intake', 'evaluation']),
  data: PatientDataSchema,
  sync: PatientSyncSchema.optional(),
  meta: PatientMetaSchema.optional(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;
export type SharedJob = z.infer<typeof SharedJobSchema>;
export type SharedData = z.infer<typeof SharedDataSchema>;
export type PatientData = z.infer<typeof PatientDataSchema>;
export type PatientSyncConflict = z.infer<typeof PatientSyncConflictSchema>;
export type PatientSyncWarning = z.infer<typeof PatientSyncWarningSchema>;
export type PatientSync = z.infer<typeof PatientSyncSchema>;
export type PatientMeta = z.infer<typeof PatientMetaSchema>;
export type Patient = z.infer<typeof PatientSchema>;
