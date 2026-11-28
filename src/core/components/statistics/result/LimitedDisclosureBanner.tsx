// 제한데이터 소수 셀 해제 배너 — P2-78c에서 ResultPanel.tsx의 선언을 본문 그대로 옮겼다.
import type { LimitedDisclosureStatus } from '@wr/contracts/stats';

// 제한데이터 권한자 응답 전용(서버가 응답 시점에만 붙인다 — shared/contracts LimitedDisclosureStatusSchema).
// applied는 소수 인원(1~9명) 보호가 해제됐다는 경고 배너이고, unavailable_*는 해제를 시도했지만 못 해
// 일반(집계) 결과를 보여 준다는 안내다. 필드가 없으면 일반 응답이라 아무것도 그리지 않는다.
const LIMITED_DISCLOSURE_MESSAGES: Record<string, string> = {
  applied: '제한데이터 권한: 소수 인원(10명 미만) 보호가 해제된 결과입니다. 화면 캡처·반출·공유에 주의하세요.',
  unavailable_engine_busy: '제한 해제 계산이 다른 작업과 겹쳐 일반(집계) 결과를 표시합니다. 잠시 후 다시 조회하세요.',
  unavailable_computation_failed: '제한 해제 계산에 실패해 일반(집계) 결과를 표시합니다. 다시 시도하세요.',
  unavailable_engine_degraded: '통계 엔진 상태가 불안정해 제한 해제를 할 수 없어 일반(집계) 결과를 표시합니다. 관리자에게 문의하세요.',
  unavailable_input_too_large: '데이터가 커서 제한 해제를 할 수 없어 일반(집계) 결과를 표시합니다. 필터로 범위를 줄여 보세요.',
  unavailable_group_limit: '그룹 수가 많아 제한 해제를 할 수 없어 일반(집계) 결과를 표시합니다. 필터로 범위를 줄이거나 다른 그룹 변수를 선택하세요.',
  unavailable_method_not_executable: '소수 인원 보호를 풀어 보니 선택한 분석 방법을 현재 데이터로 실행할 수 없어 일반(집계) 결과를 표시합니다. 분석 방법이나 변수를 바꿔 보세요.',
  unavailable_source_missing: '이 실행은 제한 해제에 필요한 원본이 보존되지 않았습니다(권한을 받기 전에 실행했거나 보존 기간이 지남). 분석을 다시 실행하면 해제됩니다.',
  unavailable_version_drift: '분석 규칙·엔진 버전이 바뀌어 이 실행은 제한 해제를 할 수 없습니다. 분석을 다시 실행하세요.',
};

export function LimitedDisclosureBanner({ status }: { status: LimitedDisclosureStatus | undefined }) {
  if (!status) return null;
  const text = LIMITED_DISCLOSURE_MESSAGES[status]
    ?? '제한 해제를 적용하지 못해 일반(집계) 결과를 표시합니다. 다시 실행하세요.';
  return <div className="swb-banner" role="status" style={{ marginBottom: 12 }}>{text}</div>;
}
