// The completion columns of a patient write (S7-8a — one copy of what create, PATCH, the video apply and the
// workspace save each computed): the client's report (three states, §5.5) and the server's own verification
// (analytics-core, PR0-B2), both from the row as stored (or the draft defaults for a new patient).
import {
  nextCompletionColumns, nextVerificationColumns, verifyModulesComplete, logCompletionMismatchIfAny,
  DRAFT_COMPLETION_COLUMNS, DRAFT_VERIFICATION_COLUMNS, type CompletionColumns, type VerificationColumns,
} from '../../completionTracking';

export interface CompletionReport {
  modulesCompleteObserved?: boolean;
  completionClientBuildVersion?: string;
  completionClientSchemaVersion?: number;
}

/** What the server verifies: the patient's data as it will be stored. */
export interface VerificationInput {
  shared: Record<string, unknown>;
  modules: Record<string, unknown>;
  activeModules: string[];
}

/**
 * @param current the stored row (locked by the caller), or null for a new patient.
 * Logs a mismatch between the client's report and the server's verification.
 */
export function nextCompletionState(
  current: (CompletionColumns & VerificationColumns) | null,
  report: CompletionReport,
  verify: VerificationInput,
  patientId: string,
): { completion: CompletionColumns; verification: VerificationColumns } {
  const completion = nextCompletionColumns(current ?? DRAFT_COMPLETION_COLUMNS, report);
  const verified = verifyModulesComplete(verify);
  logCompletionMismatchIfAny(patientId, report.modulesCompleteObserved, verified);
  const verification = nextVerificationColumns(current ?? DRAFT_VERIFICATION_COLUMNS, verified.allComplete);
  return { completion, verification };
}
