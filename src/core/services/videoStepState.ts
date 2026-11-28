// 영상 분석 화면의 상태 편집 순수 헬퍼와 공용 상수(P2-75c, Phase 2 C9 구간 D) — 공정·클립 추가·수정·삭제(입력이 바뀌면 분석 파생값을 비운다),
// 적용 경로·대상 작업 결정, 요청 feature 목록. 다른 영상 서비스를 import하지 않는다(videoProvenance·videoServerApply·videoAnalysisRun이
// 여기 것을 가져가도 순환이 생기지 않게). 본문은 VideoAnalysisStep에 있던 그대로다.
import { VIDEO_FEATURE_TARGETS } from '@wr/contracts/index';
import type { FeatureKey } from '@wr/contracts/index';
import { filterAnalysisJobs } from '@wr/analytics-core/jobScope';
import type { VideoClip, UploadState, ModuleTask, VideoProcess, VideoAnalysisData, SharedJob } from './videoStepTypes';

export const VIEWPOINTS = [
  { value: 'sagittal', label: '측면(sagittal)' },
  { value: 'frontal', label: '정면(frontal)' },
  { value: 'other', label: '기타' },
];
// desc: 프로필 선택 시 select 옆에 보이는 짧은 설명(출처: shared/contracts/videoAnalysis.ts 프로필 정의 주석).
export const PROFILES = [
  { value: 'posture-basic', label: '자세시간(5~10fps)', desc: '쪼그려앉기·허리 구부리기·오버헤드 자세시간 추정' },
  { value: 'repetition-upper-limb', label: '상지반복(10~15fps)', desc: '어깨·팔꿈치 반복 빈도와 속도 구간별 시간 추정' },
  { value: 'hand-wrist', label: '손목·손(15~30fps)', desc: '손목 굴곡·편위와 손목·손가락 반복 추정' },
];
export const MOCK_BUNDLE = 'mock-6.0-2';

// ── 순수 헬퍼(테스트 대상) ────────────────────────────────────────────────
/**
 * 대상자 탐지(sample-detect) 가능 여부. 서버 모드 전제.
 * 실 업로드 완료 clip(upload.status==='done') 또는 dev fixture 파일명 보유 clip만 탐지 가능(M3-7a).
 */
export function canDetectClip({ serverMode, fixtureMode, clip, upload }: { serverMode: boolean; fixtureMode: boolean; clip: VideoClip; upload?: UploadState }): boolean {
  if (!serverMode) return false;
  if (upload && upload.status === 'done' && upload.serverClipId) return true;
  return !!(fixtureMode && clip.fixtureClipName);
}

/** 활성 모듈로 매핑되는 모든 featureKey(자동·candidate 포함). */
export function requestedFeaturesForModules(activeModules: string[] = []): string[] {
  return Object.keys(VIDEO_FEATURE_TARGETS).filter(
    (k) => activeModules.includes(VIDEO_FEATURE_TARGETS[k as FeatureKey].moduleId)
  );
}

/**
 * task-scope 모듈의 적용 대상 task 후보(직업 기준). spine처럼 fallbackUnlinked면 매칭 task가 없을 때
 * 직업 미연결 레거시 task도 후보로 허용한다(모듈 extractFromModule fallback과 동일 규칙). cervical은 엄격.
 */
export function tasksForJob(
  moduleData: { tasks?: ModuleTask[] } | null | undefined, sharedJobId: string,
  { fallbackUnlinked = false }: { fallbackUnlinked?: boolean } = {},
): ModuleTask[] {
  const all = (moduleData && moduleData.tasks) || [];
  const linked = all.filter((t) => t.sharedJobId === sharedJobId);
  if (!linked.length && fallbackUnlinked) return all.filter((t) => !t.sharedJobId);
  return linked;
}

/**
 * 적용 대상 taskId 해석: 선택값(selectedTaskId)이 **현재 후보 목록에 실제 존재**할 때만 유효(stale 방어).
 * 없으면 후보가 1개일 때 자동 지정, 그 외 null(=대상 없음 → 적용 비활성).
 */
export function resolveTargetTaskId(tasks: ModuleTask[] = [], selectedTaskId: string | number | null | undefined): string | number | null {
  if (selectedTaskId != null && tasks.some((t) => String(t.id) === String(selectedTaskId))) return selectedTaskId;
  if (tasks.length === 1) return tasks[0].id;
  return null;
}

/** 공정 시간점유율 합(직업별). 100% 초과/미달 경고용. */
export function shareTotalsByJob(processes: VideoProcess[] = []): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const p of processes) {
    totals[p.sharedJobId] = (totals[p.sharedJobId] || 0) + (Number(p.shiftSharePercent) || 0);
  }
  return totals;
}

// 입력(공정/클립)이 바뀌면 mock 분석 파생결과는 stale이 되므로 비운다(잘못된 기준 적용 방지).
// 이미 모듈에 적용된 값(appliedInputs)·provenance는 보존한다.
export function clearDerived(va: VideoAnalysisData): VideoAnalysisData {
  return { ...va, processFeatures: [], jobFeatures: [], candidateFeatures: [] };
}
export function addProcessVA(va: VideoAnalysisData, jobs: SharedJob[] = []): VideoAnalysisData {
  return clearDerived({
    ...va,
    processes: [...va.processes, {
      id: crypto.randomUUID(),
      // 새 공정의 기본 직력은 첫 "신체부담평가 포함" 직력(전부 미포함이면 첫 직력)
      sharedJobId: (filterAnalysisJobs(jobs)[0] || jobs[0])?.id || '',
      name: `공정 ${va.processes.length + 1}`,
      shiftSharePercent: 0,
      activeMinutesPerDay: null, // 공정활동분/일(수기). per-day 환산 입력. null=모름(적용 불가).
      analysisProfile: 'posture-basic',
    }],
  });
}
export function editProcessVA(va: VideoAnalysisData, id: string, patch: Partial<VideoProcess>): VideoAnalysisData {
  return clearDerived({ ...va, processes: va.processes.map((p) => (p.id === id ? { ...p, ...patch } : p)) });
}
export function removeProcessVA(va: VideoAnalysisData, id: string): VideoAnalysisData {
  return clearDerived({
    ...va,
    processes: va.processes.filter((p) => p.id !== id),
    clips: va.clips.filter((c) => c.processId !== id),
  });
}
export function addClipVA(va: VideoAnalysisData, processId: string): VideoAnalysisData {
  return clearDerived({
    ...va,
    clips: [...va.clips, { id: crypto.randomUUID(), processId, viewpoint: 'sagittal', analysisProfile: 'posture-basic' }],
  });
}
export function editClipVA(va: VideoAnalysisData, id: string, patch: Partial<VideoClip>): VideoAnalysisData {
  return clearDerived({ ...va, clips: va.clips.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
}
export function removeClipVA(va: VideoAnalysisData, id: string): VideoAnalysisData {
  return clearDerived({ ...va, clips: va.clips.filter((c) => c.id !== id) });
}

// 적용 경로 결정: 인트라넷=서버(synced 필요), 인트라넷+미동기=차단, 그 외=로컬.
export function resolveApplyMode(serverSupported: boolean, isSynced: boolean): 'server' | 'blocked' | 'local' {
  if (serverSupported && isSynced) return 'server';
  if (serverSupported && !isSynced) return 'blocked';
  return 'local';
}
