import { z } from 'zod';
import { VideoAnalysisDataSchema } from './videoAnalysis';

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
  // 작업 영상 인간공학 분석(§8.11). 구파일 parse 호환 위해 optional — 런타임은 ensureSharedDefaults로 보강(PR2).
  videoAnalysis: VideoAnalysisDataSchema.optional(),
  // 종합소견 출력 옵션(패턴 그룹화 등). 없으면(구파일) 전부 false로 취급 — 기존 출력 불변.
  reportOptions: z.object({
    groupAssessmentResults: z.boolean().optional(),
  }).optional(),
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
  assignmentWarnings: z.array(PatientSyncWarningSchema).optional(),
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
  assignedDoctorUserId: z.string().uuid().nullable().optional(),
});

// GET /api/patients/:id/lock 전용 응답 스키마 — 일시적인 편집 락 상태를 나타낸다.
// 의도적으로 PatientSchema에는 포함하지 않는다: 여기 넣으면 toResponse()를 통해
// pull/merge/workspace 스냅샷에 락 상태가 환자 데이터처럼 영속화될 수 있다. 락은 항상
// 이 별도 엔드포인트로만 조회한다. leaseToken/clientInstanceId/sessionId/userId는
// 절대 노출하지 않는다(holderName/acquiredAt/expiresAt만).
export const PatientLockInfoSchema = z.object({
  holderName: z.string(),
  acquiredAt: z.string(),
  expiresAt: z.string(),
}).nullable();

// GET /api/patients/:id/lock의 실제 응답 envelope은 { lock: PatientLockInfo|null } —
// PatientLockInfoSchema 자체는 그 안쪽(lock 값)만 모델링하므로, 응답 전체를 검증/타입화할
// 때는 이 래핑된 스키마를 사용한다.
export const PatientLockResponseSchema = z.object({
  lock: PatientLockInfoSchema,
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
export type PatientLockInfo = z.infer<typeof PatientLockInfoSchema>;
export type PatientLockResponse = z.infer<typeof PatientLockResponseSchema>;
