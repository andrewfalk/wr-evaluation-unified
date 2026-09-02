import { z } from 'zod';

// PR0-A: 환자 완료시각 추적(§5.5). patient_records를 직접 갱신하는 모든 경로가 공유해야
// 하는 계약 — patients.ts(PATCH/POST)뿐 아니라 workspaces.ts(수동 workspace 저장)와
// videoAnalysis.ts(영상분석 결과 적용)도 patient_records.payload를 직접 바꾸므로, 이 셋
// 중 하나라도 빠지면 그 경로로만 저장된 환자는 실제로 완료됐어도 completion_status가
// 영원히 'draft'로 남거나, 다시 불완전해졌는데 옛 'modules_complete'가 남을 수 있다.
//
// modulesCompleteObserved는 3상태(undefined/true/false) — undefined면 기존 완료 상태를
// 건드리지 않는다(구버전 클라이언트 호환). true일 때만 실제로 새 값을 쓰므로 버전 필드는
// 그때만 필수.
export const CompletionReportFields = {
  modulesCompleteObserved:        z.boolean().optional(),
  completionClientBuildVersion:   z.string().max(64).optional(),
  completionClientSchemaVersion:  z.number().int().nonnegative().optional(),
};

export function requireCompletionVersions<T extends {
  modulesCompleteObserved?: boolean;
  completionClientBuildVersion?: string;
  completionClientSchemaVersion?: number;
}>(data: T, ctx: z.RefinementCtx): void {
  if (data.modulesCompleteObserved !== true) return;
  if (data.completionClientBuildVersion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completionClientBuildVersion'], message: 'Required when modulesCompleteObserved is true' });
  }
  if (data.completionClientSchemaVersion === undefined) {
    ctx.addIssue({ code: 'custom', path: ['completionClientSchemaVersion'], message: 'Required when modulesCompleteObserved is true' });
  }
}

export interface CompletionColumns {
  completion_status:                   string;
  server_observed_modules_complete_at: Date | null;
  completion_source:                   string | null;
  completion_client_build_version:     string | null;
  completion_client_schema_version:    number | null;
}

// 신규 행(FOR UPDATE로 잠글 기존 행이 없는 경우)의 시작값 — 전부 미관측 상태.
export const DRAFT_COMPLETION_COLUMNS: CompletionColumns = {
  completion_status:                   'draft',
  server_observed_modules_complete_at: null,
  completion_source:                   null,
  completion_client_build_version:     null,
  completion_client_schema_version:    null,
};

export function nextCompletionColumns(
  current: CompletionColumns,
  report: { modulesCompleteObserved?: boolean; completionClientBuildVersion?: string; completionClientSchemaVersion?: number }
): CompletionColumns {
  if (report.modulesCompleteObserved === undefined) return current;

  if (report.modulesCompleteObserved === false) {
    return { ...current, completion_status: 'draft' };
  }

  // true — first false→true transition stamps provenance; later transitions only flip status.
  if (current.server_observed_modules_complete_at !== null) {
    return { ...current, completion_status: 'modules_complete' };
  }
  return {
    completion_status:                   'modules_complete',
    server_observed_modules_complete_at: new Date(),
    completion_source:                   'client_reported',
    completion_client_build_version:     report.completionClientBuildVersion ?? null,
    completion_client_schema_version:    report.completionClientSchemaVersion ?? null,
  };
}
