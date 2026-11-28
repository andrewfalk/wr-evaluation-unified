// 영상 분석 화면 조각(components/video/)이 본체와 함께 쓰는 화면 상태·props 타입(P2-75e, Phase 2 C9 구간 D).
// 상태는 본체(VideoAnalysisStep)가 들고, 조각은 props로 받는다.
import type { Dispatch, ReactNode, SetStateAction } from 'react';
import type { buildAppliedRecipe } from '@wr/contracts/index';
import type { getModuleCandidates, getModuleSuggestions } from '../../services/videoProvenance';
import type { SampleDetectResult } from '../TargetPicker';
import type { RunServerAnalysisOptions } from '../../services/videoAnalysisRun';
import type {
  EvidenceByFeatureKey, FeatureEvidence, InferenceDevice, ModuleTask, ProcessEvidence, ProcessFeatures, SharedJob, SuppressedCandidate,
  UploadState, VideoAnalysisData, VideoClip, VideoProcess,
} from '../../services/videoStepTypes';

/** 대상자 탐지 결과(클립별, 화면 임시 상태 — 환자 데이터에 저장하지 않는다). */
export interface DetectionState {
  serverClipId: string;
  result: SampleDetectResult;
  selectedId: string | null;
  clipKey: string | null;
  frameUrl: string | null;
}

/** "왜 이 값?" 근거·시점 게이트 안내·실행 디바이스(분석 세션 한정, 영속화 안 함). */
export interface AnalysisEvidenceState {
  jobEvidenceBySharedJobId: Record<string, EvidenceByFeatureKey>;
  processEvidenceByProcessId: Record<string, EvidenceByFeatureKey>;
  suppressedCandidates: SuppressedCandidate[];
  deviceByProcessId: Record<string, InferenceDevice>;
}

/** 셋업 열(SetupColumn) — 본체의 상태·파생값 14개와 핸들러 10개를 그대로 받는다(이름도 본체 그대로). */
export interface SetupColumnProps {
  va: VideoAnalysisData;
  jobs: SharedJob[];
  activeModules: string[];
  shareTotals: Record<string, number>;
  analysisEvidence: AnalysisEvidenceState;
  jobName: (id: string) => string;
  uploads: Record<string, UploadState>;
  serverMode: boolean;
  fixtureMode: boolean;
  detecting: string | null;
  analyzing: boolean;
  pipelineSteps: string[];
  pipelineIndex: number;
  validDetection: (clipMeta: VideoClip) => DetectionState | null;
  addProcess: () => void;
  editProcess: (id: string, patch: Partial<VideoProcess>) => void;
  removeProcess: (id: string) => void;
  addClip: (processId: string) => void;
  editClip: (id: string, patch: Partial<VideoClip>) => void;
  removeClip: (id: string) => void;
  uploadClipFile: (clipMeta: VideoClip, processId: string, file: File | null) => Promise<void>;
  detectTarget: (clipMeta: VideoClip, processId: string) => Promise<void>;
  chooseTarget: (clipMeta: VideoClip, personId: string) => Promise<void>;
  runAnalysis: () => Promise<void>;
}

// ── 본체의 상태·props 타입(P2-75b-ts에서 붙이고 P2-75f에서 이 파일로 옮김) ──
export interface OverlayState {
  loading?: boolean;
  data?: object;
  error?: string;
  closed?: boolean;
}

export type SourceRecipe = Parameters<typeof buildAppliedRecipe>[0][number];
export type ModuleSuggestion = ReturnType<typeof getModuleSuggestions>[number];
export type ModuleCandidate = ReturnType<typeof getModuleCandidates>[number];
export type ApplyContext = { sharedJobId: string } | { taskId: string | number | null };

/** runServerAnalysis의 결과(그 파일의 JSDoc에는 recipesByJobId가 빠져 있다). */
export interface ServerAnalysisResult {
  processFeatures: ProcessFeatures[];
  processEvidence: ProcessEvidence[];
  missingActiveTime: Record<string, string[]>;
  bundleVersion: string | null;
  recipesByJobId?: Record<string, SourceRecipe> | null;
  errors: Array<{ message: string }>;
}

/** 요청 오류(requestJson)는 status·data만 갖는다. */
export type RequestError = Error & { data?: { code?: string; error?: { code?: string } } };

export interface SharedData {
  videoAnalysis?: VideoAnalysisData;
  jobs?: SharedJob[];
  doctorName?: string;
  [key: string]: unknown;
}

export interface PatientData {
  shared: SharedData & { videoAnalysis: VideoAnalysisData };
  modules: Record<string, { tasks?: ModuleTask[] } | undefined>;
  [key: string]: unknown;
}

export interface ActivePatient {
  id?: string;
  sync?: { serverId?: string; syncStatus?: string };
  data?: PatientData;
}

export interface VideoAnalysisStepProps {
  shared: SharedData | null | undefined;
  updateShared: (next: SharedData) => void;
  updatePatient: (updater: (data: PatientData) => PatientData) => void;
  activePatient: ActivePatient | null | undefined;
  activeModules?: string[];
  session?: { user?: { name?: string } } | null;
  settings?: unknown;
  fixtureMode?: boolean;
  serverConfig?: RunServerAnalysisOptions['serverConfig'];
  onServerApplied?: (serverPatient: unknown) => void;
}

/** 검토 행(SuggestionRow·CandidateRow)이 읽는 본체 값 — 렌더 함수였을 때 클로저로 읽던 것(P2-75f). */
export interface ReviewRowContext {
  expandedEvidence: string | null;
  setExpandedEvidence: (key: string | null) => void;
  applyNotes: Record<string, string>;
  setApplyNotes: Dispatch<SetStateAction<Record<string, string>>>;
  busy: boolean;
  applyBlocked: boolean;
  applySuggestion: (
    moduleId: string, ctx: ApplyContext, s: ModuleSuggestion, processIds: string[] | undefined,
    analysisProfile: string | undefined, editReason: string | undefined,
  ) => Promise<void>;
  renderEvidencePanel: (jobEv: FeatureEvidence | null | undefined, unit: string | null | undefined) => ReactNode;
  renderSkeletonReview: (rowKey: string, jobEv: FeatureEvidence | null | undefined) => ReactNode;
}

/** 제안 1건 행 — 렌더 함수의 두 번째 인자였던 것 그대로 + review. */
export interface SuggestionRowProps {
  s: ModuleSuggestion;
  moduleId: string;
  ctx: ApplyContext;
  processIds: string[];
  analysisProfile: string | undefined;
  jobEv: FeatureEvidence | undefined;
  rowKey: string;
  applyDisabled?: boolean;
  applyDisabledTitle?: string;
  review: ReviewRowContext;
}

/** 관찰값(candidate) 행. */
export interface CandidateRowProps {
  c: ModuleCandidate;
  activeMinutesPerDay: number | null;
  jobEv: FeatureEvidence | undefined;
  rowKey: string;
  review: ReviewRowContext;
}

export interface JobScopeReviewProps {
  va: VideoAnalysisData;
  jobScopeModules: string[];
  jobName: (id: string) => string;
  analysisEvidence: AnalysisEvidenceState;
  review: ReviewRowContext;
}

export interface TaskScopeReviewProps {
  va: VideoAnalysisData;
  taskScopeModules: string[];
  activePatient: ActivePatient | null | undefined;
  taskTargets: Record<string, string>;
  setTaskTargets: Dispatch<SetStateAction<Record<string, string>>>;
  analysisEvidence: AnalysisEvidenceState;
  jobName: (id: string) => string;
  review: ReviewRowContext;
}

export interface AppliedHistoryProps {
  va: VideoAnalysisData;
  serverMode: boolean;
  rollback: (entry: VideoAnalysisData['appliedInputs'][number]) => void;
}
