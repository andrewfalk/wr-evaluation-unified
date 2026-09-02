import config from './config';

// `config`는 frozen이라 배포 이후 self-check 실패를 반영할 수 없다(§7.6). 이 모듈이
// 그 대신 쓰는 가변 상태 저장소다. PR0-A는 초기값만 채우고 setter를 호출하는 self-check가
// 아직 없다 — Python worker 헬스체크(PR1)가 붙으면 그때부터 setStatsWorkbenchAvailability를
// 호출해 available을 갱신한다. requireCapability가 이미 getter를 읽으므로 죽은 코드는 아니다.
export interface StatsWorkbenchAvailability {
  available: boolean;
  reason:    string | null;
  checkedAt: string | null;
}

let state: StatsWorkbenchAvailability = {
  // Statistics Workbench는 인트라넷에서만 활성화한다 — standalone Electron/Vercel에는
  // 조직 DB도 Node 통계 서버도 없어 canonical snapshot을 만들 수 없다(§7.6).
  available: config.statsWorkbenchEnabled && config.deploymentMode === 'intranet',
  reason:    null,
  checkedAt: null,
};

export function getStatsWorkbenchAvailability(): StatsWorkbenchAvailability {
  return state;
}

export function setStatsWorkbenchAvailability(available: boolean, reason: string | null = null): void {
  state = { available, reason, checkedAt: new Date().toISOString() };
}
