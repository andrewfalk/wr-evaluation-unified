import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  nextCompletionColumns,
  DRAFT_COMPLETION_COLUMNS,
  verifyModulesComplete,
  logCompletionMismatchIfAny,
  nextVerificationColumns,
  DRAFT_VERIFICATION_COLUMNS,
  COMPLETION_ENGINE_VERSION,
} from '../completionTracking';

const KNEE_MODULE_DATA = { knee: {} };

describe('verifyModulesComplete', () => {
  it('activeModules가 비어 있으면 allComplete=false다', () => {
    expect(verifyModulesComplete({ shared: {}, modules: {}, activeModules: [] }).allComplete).toBe(false);
  });

  // modules['knee']가 없으면(undefined) analytics-core의 §P1 방어에 걸려 errored로
  // 차단된다 — module 데이터를 유효한 빈 객체로 채워야 knee의 isComplete가 실제로 실행된다.
  it('module 데이터가 있어도 shared가 비어 있으면 allComplete=false다(무릎은 무릎 진단이 없으면 미완료)', () => {
    const result = verifyModulesComplete({ shared: {}, modules: KNEE_MODULE_DATA, activeModules: ['knee'] });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds).toEqual([]);
    expect(result.failedModuleIds).toEqual(['knee']);
  });

  // M17.0은 analytics-core의 ICD_MODULE_MAP에서 무릎으로 확정 매핑되는 코드다 — knee의
  // isComplete는 module 데이터를 전혀 읽지 않고 shared.diagnoses만 본다(코드로 직접 확인).
  it('무릎 진단이 실제 완료 조건을 만족하면 allComplete=true다', () => {
    const result = verifyModulesComplete({
      shared: {
        diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }],
      },
      modules: KNEE_MODULE_DATA,
      activeModules: ['knee'],
    });
    expect(result.allComplete).toBe(true);
  });

  it('무릎 진단이 있어도 side가 없으면 allComplete=false다', () => {
    const result = verifyModulesComplete({
      shared: { diagnoses: [{ code: 'M17.0' }] },
      modules: KNEE_MODULE_DATA,
      activeModules: ['knee'],
    });
    expect(result.allComplete).toBe(false);
  });

  it('클라이언트가 완료로 신고해도(진단이 실제로는 다른 모듈로 매핑됨) 서버 재검증은 독립적으로 false를 낼 수 있다', () => {
    // M54.5(요통)는 척추로 매핑되므로 activeModules가 knee뿐이면 무릎 진단으로 인정되지 않는다
    // — 클라이언트 자기신고(modulesCompleteObserved)와 서버 재검증이 갈릴 수 있다는 걸 보여준다.
    const result = verifyModulesComplete({
      shared: { diagnoses: [{ code: 'M54.5' }] },
      modules: KNEE_MODULE_DATA,
      activeModules: ['knee'],
    });
    expect(result.allComplete).toBe(false);
  });

  // §리뷰 지적(P1) 회귀 방지: 모듈 데이터 자체가 없거나(undefined) 손상되면(null 등)
  // isComplete를 호출하지 않고 차단해야 한다 — 완료된 무릎 진단이 있어도 마찬가지다.
  it.each([
    ['modules 자체가 없음', {}],
    ['knee 값이 null', { knee: null }],
    ['knee 값이 배열', { knee: [] }],
  ])('완료된 무릎 진단이 있어도 module 데이터가 %s이면 allComplete=false다', (_label, modules) => {
    const result = verifyModulesComplete({
      shared: { diagnoses: [{ code: 'M17.0', side: 'right', confirmedRight: 'confirmed', assessmentRight: 'high' }] },
      modules,
      activeModules: ['knee'],
    });
    expect(result.allComplete).toBe(false);
    expect(result.errorModuleIds).toEqual(['knee']);
  });
});

describe('logCompletionMismatchIfAny', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('클라이언트가 true로 신고했는데 서버 검증이 false면 경고 로그를 남긴다', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logCompletionMismatchIfAny('patient-1', true, { allComplete: false, failedModuleIds: ['knee'], errorModuleIds: [] });
    expect(spy).toHaveBeenCalledWith(
      '[completion] client reported complete but server verification disagrees',
      expect.objectContaining({ patientId: 'patient-1', failedModuleIds: ['knee'], errorModuleIds: [] }),
    );
  });

  it('클라이언트가 true로 신고했고 서버 검증도 true면 로그를 남기지 않는다', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logCompletionMismatchIfAny('patient-1', true, { allComplete: true, failedModuleIds: [], errorModuleIds: [] });
    expect(spy).not.toHaveBeenCalled();
  });

  it('클라이언트가 false거나 신고하지 않았으면(undefined) 서버 검증이 false여도 로그를 남기지 않는다', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logCompletionMismatchIfAny('patient-1', false, { allComplete: false, failedModuleIds: ['knee'], errorModuleIds: [] });
    logCompletionMismatchIfAny('patient-1', undefined, { allComplete: false, failedModuleIds: ['knee'], errorModuleIds: [] });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('nextVerificationColumns', () => {
  it('verified=false면 현재 값을 그대로 유지한다', () => {
    expect(nextVerificationColumns(DRAFT_VERIFICATION_COLUMNS, false)).toEqual(DRAFT_VERIFICATION_COLUMNS);
  });

  it('verified=true, 최초 전이면 현재 시각과 엔진 버전을 stamp한다', () => {
    const before = Date.now();
    const result = nextVerificationColumns(DRAFT_VERIFICATION_COLUMNS, true);
    expect(result.server_verified_modules_complete_at).toBeInstanceOf(Date);
    expect((result.server_verified_modules_complete_at as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(result.completion_verification_engine_version).toBe(COMPLETION_ENGINE_VERSION);
  });

  it('이미 검증된 시각이 있으면 verified=true라도 그 시각을 덮어쓰지 않는다(최초 관측 시각 불변)', () => {
    const original = { server_verified_modules_complete_at: new Date('2020-01-01'), completion_verification_engine_version: 'v0' };
    const result = nextVerificationColumns(original, true);
    expect(result).toEqual(original);
  });

  it('이미 검증됐다가 다시 verified=false가 되어도(모듈이 재개방돼도) 기존 시각은 그대로 남는다', () => {
    const original = { server_verified_modules_complete_at: new Date('2020-01-01'), completion_verification_engine_version: 'v0' };
    const result = nextVerificationColumns(original, false);
    expect(result).toEqual(original);
  });
});

// client_reported(nextCompletionColumns)와 server_verified(nextVerificationColumns)가
// 완전히 독립된 컬럼 쌍이라는 걸 회귀로 고정한다 — 하나가 다른 하나의 값을 읽거나 바꾸면 안 된다.
describe('client_reported와 server_verified의 독립성', () => {
  it('client_reported 갱신은 verification 컬럼에 아무 영향을 주지 않는다', () => {
    const nextCompletion = nextCompletionColumns(DRAFT_COMPLETION_COLUMNS, {
      modulesCompleteObserved: true, completionClientBuildVersion: '1.0.0', completionClientSchemaVersion: 1,
    });
    expect(nextCompletion.server_observed_modules_complete_at).toBeInstanceOf(Date);
    // verification 쪽은 별도 함수 호출 없이는 절대 값이 안 생긴다 — 같은 입력에 대해 독립 호출.
    expect(nextVerificationColumns(DRAFT_VERIFICATION_COLUMNS, false)).toEqual(DRAFT_VERIFICATION_COLUMNS);
  });
});
