// Who is writing a patient record, for the patient write services (S7). Built from the request by
// http/patientWriteContext.ts; the services never see the Express request.

export interface PatientWriteActor {
  userId: string;
  role: string;
  name: string;
}

export interface PatientWriteContext {
  actor: PatientWriteActor;
  /** The session's organization (requireOrg / orgIdOf). */
  orgId: string;
  /** The caller's edit-lock lease token (X-Lock-Token, or a per-patient token from the request body). */
  leaseToken: string | null;
  /** Request details recorded in audit rows. */
  audit: { ip: string | null; userAgent: string | null };
}
