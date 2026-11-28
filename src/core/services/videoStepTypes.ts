// 영상 분석 화면(VideoAnalysisStep)과 그 순수 헬퍼(videoStep*.ts)가 함께 쓰는 타입 — 타입만 담는다(P2-75c, Phase 2 C9 구간 D).
// 이 화면이 읽고 쓰는 필드만 적는다(저장 모양의 정본은 shared/contracts/videoAnalysis.ts).

export type FeatureScalar = string | number | boolean | null | undefined;
export type AggregationMode = 'shareWeighted' | 'absolutePerDay';

export interface VideoProcess {
  id: string;
  sharedJobId: string;
  name: string;
  shiftSharePercent: number;
  activeMinutesPerDay: number | null;
  analysisProfile: string;
}

export interface VideoClip {
  id: string;
  processId: string;
  viewpoint: string;
  analysisProfile?: string;
  fixtureClipName?: string;
}

export interface VideoFeatureValue {
  kind?: string;
  value?: FeatureScalar;
  unit?: string | null;
  /** 0~1(계약 VideoFeatureValueSchema에서 필수). */
  confidence: number;
  reason?: string;
  autoSuggestAllowed?: boolean;
  requiresManualReview?: boolean;
}

export type VideoFeatureMap = Record<string, VideoFeatureValue>;

export interface ProcessFeatures {
  processId: string;
  jobId?: string;
  analysisJobIds?: string[];
  features: VideoFeatureMap;
}

export interface JobFeatures {
  sharedJobId: string;
  features: VideoFeatureMap;
}

export interface CandidateFeature {
  featureKey: string;
  value?: FeatureScalar;
  reason?: string;
  confidence?: number;
  processIds?: string[];
}

export interface AppliedInputEntry {
  moduleId: string;
  targetPath: string;
  appliedValue: unknown;
  previousValue: unknown;
}

export interface VideoAnalysisData {
  processes: VideoProcess[];
  clips: VideoClip[];
  processFeatures?: ProcessFeatures[];
  jobFeatures?: JobFeatures[];
  candidateFeatures?: CandidateFeature[];
  appliedInputs: AppliedInputEntry[];
  processFeatureAggregationMode?: AggregationMode;
}

export interface FusionCandidate {
  jobId?: string;
  viewpoint?: string;
  adopted?: boolean;
}

/** 근거 구간(클립 시간, ms) — 골격 검수 스크럽바 강조에 쓴다. */
export interface EvidenceSegment {
  startMs: number;
  endMs: number;
}

/** 서버 실분석이 공정·featureKey마다 주는 근거(영속화 안 함). */
export interface ContributionEvidence {
  intrinsicMetric?: string;
  intrinsicValue?: FeatureScalar;
  intrinsicUnit?: string;
  activeMinutesPerDay?: number | null;
  confidenceBreakdown?: Record<string, number | null | undefined>;
  fusion?: { adopted?: { viewpoint?: string; jobId?: string }; candidates?: FusionCandidate[] };
  segments?: EvidenceSegment[];
  warnings?: string[];
}

export interface EvidenceContribution {
  processId: string;
  processName: string;
  sharePercent: number;
  perDayValue: FeatureScalar;
  analysisJobIds: string[];
  evidence: ContributionEvidence;
}

/** "왜 이 값?" 패널 한 칸(직업 단위는 공정 여럿, 작업 단위는 공정 하나). */
export interface FeatureEvidence {
  aggregationMethod: string;
  contributions: EvidenceContribution[];
  analysisJobIds: string[];
}

export type EvidenceByFeatureKey = Record<string, FeatureEvidence>;

export interface SuppressedCandidate {
  featureKey: string;
  reason?: string;
  preferred?: unknown;
}

export interface InferenceDevice {
  used?: string;
  fallback?: boolean;
  reason?: string | null;
}

export interface ProcessEvidence {
  processId: string;
  analysisJobIds?: string[];
  evidenceByFeatureKey?: Record<string, ContributionEvidence>;
  suppressedCandidates?: SuppressedCandidate[];
  inferenceDevice?: InferenceDevice | null;
}

export interface SourceJob {
  jobId: string;
  processName: string | null;
  viewpoint: string | null;
  adopted: boolean;
}

export interface ModuleTask {
  id: string | number;
  sharedJobId?: string;
  name?: string;
}

export interface SharedJob {
  id: string;
  jobName?: string;
  excludeFromAnalysis?: boolean;
}

export interface UploadState {
  fileName: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  serverClipId: string | null;
}
