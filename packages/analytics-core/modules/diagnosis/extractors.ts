// Raw extractor — diagnosis grain 1호 슬라이스(§5.5 ④ "신청상병 부위군").

import type { MigrationResult, RepeatedObservation } from '../../types';
import { enumerateDiagnosisSideEntities } from '../../grainEntities';
import { resolveDiagnosisModule, isValidDiagnosisModuleId } from '../../diagnosisMapping';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

// resolveDiagnosisModule(diag, [])의 activeModules=[] 인자는 "활성 모듈이 정확히 1개일 때
// 매핑 실패를 그 모듈로 fallback"하는 UI 편의 규칙(§확정 전제 밖)을 의도적으로 끈다 — 이
// 통계 변수는 "이 진단이 실제로 어느 부위에 매치되는가"만 다뤄야 하고, "다른 부위 진단인데
// 마침 그 case가 척추 모듈 하나만 켜서 척추로 집계됨" 같은 잡음을 넣으면 안 된다.
export function extractDiagnosisIdentityModuleGroup(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return enumerateDiagnosisSideEntities(migrationResult).map((entity) => {
    const { diagnosis } = entity.source;

    // 명시적으로 "해당 모듈 없음"을 선택한 진단(예: 참고용으로만 기재) — 결측이 아니라
    // "부위군이 존재하지 않는다"는 구조적 사실이다.
    if (diagnosis.moduleId === '__none__') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_applicable', qualityFlags: entity.qualityFlags };
    }

    const hint = resolveDiagnosisModule(diagnosis, []);
    if (hint && isValidDiagnosisModuleId(hint.moduleId)) {
      return { entityKey: entity.entityKey, value: hint.moduleId, missing: null, qualityFlags: entity.qualityFlags };
    }

    // 코드/이름 어느 쪽으로도 6개 모듈 중 하나에 매치되지 않는다 — §5.5 ②의 job 직종군
    // "presetId 없는 자유 입력"과 같은 성격(legacy_unknown): 값이 없는 게 아니라 알려진
    // 분류 체계로 못 묶는 것이다.
    return {
      entityKey: entity.entityKey,
      value: null,
      missing: 'not_entered',
      qualityFlags: [...entity.qualityFlags, 'legacy_unknown'],
    };
  });
}
