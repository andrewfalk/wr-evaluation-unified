import { z } from 'zod';
import { verifyAllModulesComplete, COMPLETION_ENGINE_VERSION, type VerifiablePatientData } from '@wr/analytics-core/completion';

export { COMPLETION_ENGINE_VERSION };

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

// PR0-B2 §5.5: analytics-core 이관 이후 서버가 클라이언트 신고에 의존하지 않고 직접
// 완료를 판정한 결과 — 위 CompletionColumns(client_reported, PR0-A)와는 완전히 별도
// 컬럼이다. 기존 값을 소급해 바꾸지 않는다(원래의 provenance 보존).
export interface VerificationColumns {
  server_verified_modules_complete_at:   Date | null;
  completion_verification_engine_version: string | null;
}

export const DRAFT_VERIFICATION_COLUMNS: VerificationColumns = {
  server_verified_modules_complete_at:    null,
  completion_verification_engine_version: null,
};

// §리뷰 지적: verifyAllModulesComplete의 결과를 boolean 하나로 뭉개면, 클라이언트가
// 완료로 신고했는데 서버 재검증이 다르게 나온 경우(불일치) 원인을 알 방법이 없다 —
// 어느 모듈이 실패/오류였는지를 호출부(각 라우트)가 로그로 남길 수 있도록 그대로 넘긴다.
export interface ModulesCompletionCheck {
  allComplete:     boolean;
  failedModuleIds: string[];
  errorModuleIds:  string[];
}

// 저장되는 payload.data(shared/modules/activeModules)를 그대로 analytics-core의
// verifyAllModulesComplete에 넘겨 6개 모듈 전부의 isComplete()를 서버가 직접 실행한다.
// 클라이언트가 무엇을 신고했든(true/false/미신고) 매번 독립적으로 재검증한다 — 클라이언트
// 신고를 트리거 조건으로 게이팅하지 않는다. 실행 자체가 예외를 던지면(예상치 못한 payload
// 형태 등) 쓰기 요청을 실패시키지 않고 "검증 불가 = 미완료"로 흡수한다 — 완료시각 기록은
// 부가 기능이지 쓰기 성공의 전제조건이 아니다.
export function verifyModulesComplete(patientData: VerifiablePatientData): ModulesCompletionCheck {
  try {
    const result = verifyAllModulesComplete(patientData);
    return { allComplete: result.allComplete, failedModuleIds: result.failedModuleIds, errorModuleIds: result.errorModuleIds };
  } catch {
    return { allComplete: false, failedModuleIds: [], errorModuleIds: [] };
  }
}

// 클라이언트가 완료로 신고했는데 서버의 독립 재검증이 동의하지 않으면 — 클라이언트/서버의
// "완료" 판정 기준이 어긋났거나 데이터가 손상됐다는 신호이므로 원인 추적용으로 남긴다.
// (반대 방향 — 클라이언트가 false/미신고인데 서버는 true — 는 서버가 더 엄격한 쪽으로
// 어긋난 것이라 당장 문제되지 않아 로그하지 않는다.) patientId는 로그 상관관계용일 뿐
// PHI를 포함하지 않는다.
export function logCompletionMismatchIfAny(
  patientId: string,
  modulesCompleteObserved: boolean | undefined,
  check: ModulesCompletionCheck,
): void {
  if (modulesCompleteObserved !== true || check.allComplete) return;
  console.warn('[completion] client reported complete but server verification disagrees', {
    patientId,
    failedModuleIds: check.failedModuleIds,
    errorModuleIds:  check.errorModuleIds,
  });
}

// server_observed_modules_complete_at(PR0-A)와 동일하게 false→true 최초 전이에서만
// 시각을 새로 찍는다. 이미 검증됨(not null)이면 그대로 유지 — 모듈이 나중에 다시
// 불완전해져도(completion_status가 draft로 돌아가도) 이 시각은 "최초로 서버가 검증에
// 성공한 시점"이므로 불변이다.
export function nextVerificationColumns(current: VerificationColumns, verified: boolean): VerificationColumns {
  if (!verified) return current;
  if (current.server_verified_modules_complete_at !== null) return current;
  return {
    server_verified_modules_complete_at:    new Date(),
    completion_verification_engine_version: COMPLETION_ENGINE_VERSION,
  };
}
