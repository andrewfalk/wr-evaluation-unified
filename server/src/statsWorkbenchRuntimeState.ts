import config from './config';

// `config`는 frozen이라 배포 이후 self-check 실패를 반영할 수 없다(§7.6). 이 모듈이
// 그 대신 쓰는 가변 상태 저장소다. PR0-A는 초기값만 채우고 setter를 호출하는 self-check가
// 아직 없다 — Python worker 헬스체크(PR1)가 붙으면 그때부터 setStatsWorkbenchHealthy를
// 호출해 available을 갱신한다. requireCapability가 이미 getter를 읽으므로 죽은 코드는 아니다.
//
// Statistics Workbench는 인트라넷에서만 활성화한다 — standalone Electron/Vercel에는 조직 DB도
// Node 통계 서버도 없어 canonical snapshot을 만들 수 없다(§7.6). 이 배포모드 게이트는 setter가
// 절대 우회할 수 없어야 한다 — setter는 "런타임 헬스"만 갱신하고, 최종 available은 매번
// 배포모드/flag와 AND로 다시 계산한다. (이전 설계는 setter가 `available`을 직접 받아 통째로
// 덮어썼는데, 향후 헬스체크 코드가 무심코 setStatsWorkbenchAvailability(true)만 호출하면
// standalone·flag-off 환경에서도 워크벤치가 열리는 취약점이 될 수 있었다.)
export interface StatsWorkbenchAvailability {
  available: boolean;
  reason:    string | null;
  checkedAt: string | null;
}

const deploymentGateOpen = config.statsWorkbenchEnabled && config.deploymentMode === 'intranet';

let runtimeHealthy = true;
let lastReason: string | null = null;
let lastCheckedAt: string | null = null;

export function getStatsWorkbenchAvailability(): StatsWorkbenchAvailability {
  return {
    available: deploymentGateOpen && runtimeHealthy,
    reason:    deploymentGateOpen ? lastReason : null,
    checkedAt: lastCheckedAt,
  };
}

// PR1의 Python worker 헬스체크 등 런타임 자가진단 결과만 반영한다 — 배포모드/flag는
// 항상 별도로 강제되므로 이 함수에 true를 넘겨도 standalone·flag-off 환경은 열리지 않는다.
export function setStatsWorkbenchHealthy(healthy: boolean, reason: string | null = null): void {
  runtimeHealthy = healthy;
  lastReason     = reason;
  lastCheckedAt  = new Date().toISOString();
}
