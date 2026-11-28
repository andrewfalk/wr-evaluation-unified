// 영상 분석 화면 조각(components/video/)이 본체와 함께 쓰는 화면 상태·props 타입(P2-75e, Phase 2 C9 구간 D).
// 상태는 본체(VideoAnalysisStep)가 들고, 조각은 props로 받는다.
import type { SampleDetectResult } from '../TargetPicker';
import type {
  EvidenceByFeatureKey, InferenceDevice, SharedJob, SuppressedCandidate, UploadState, VideoAnalysisData, VideoClip, VideoProcess,
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
