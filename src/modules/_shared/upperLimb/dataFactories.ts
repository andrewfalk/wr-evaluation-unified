// 팔꿈치·손목 공용 데이터 팩토리·sync(REFACTORING_ROADMAP Phase 2 C8, P2-69b).
// 두 모듈의 utils/data는 서로 복사해 만든 쌍둥이였다 — 같은 로직(엔트리·직력·모듈 팩토리, 분기 초기화, 옛 형식 변환,
// 정규화, 대표값 자동 복사, 프리셋 대기 적용, sync)을 여기 한 벌로 두고, 모듈마다 다른 것은 config로 받는다:
//   · entryFields — 엔트리의 필드와 **순서**(골든은 JSON 텍스트라 키 순서까지 고정한다), 빈 값 종류(문자열/목록)
//   · branchFields — BK 유형별 분기 필드(분기 초기화가 비운다)
//   · exposureTypeOptions — 정규화가 남기는 공통 노출 유형
//   · inferBkType · isDiagnosis — 상병명·코드 → BK 유형, 이 모듈 상병인지(손목은 추론으로도 판정)
//   · toolPressingSources — bk2103_tool_pressing이 비었을 때 'yes'로 채우는 근거 필드(팔꿈치 3개, 손목 1개)
//   · diagnosesKey — sync 반환에서 상병 목록의 키 이름(elbowDiagnoses/wristDiagnoses)
// 값은 각 모듈의 utils/data.ts가 지금 값 그대로 적고, 지금 이름 그대로 다시 내보낸다(경로로 import하는 소비자가 있다).
import { stableStringify } from '../../../core/utils/common';

/** 상병(공용 shared.diagnoses 항목) 가운데 이 파일이 읽는 필드. */
export interface UpperLimbDiagnosisLike {
  id?: string;
  code?: string;
  name?: string;
  moduleId?: string | null;
}

/** 직력(shared.jobs 항목) 가운데 이 파일이 읽는 필드. */
export interface UpperLimbJobLike {
  id: string;
}

/** 직력 × 상병 한 칸의 입력값(엔트리 팩토리의 모양 + 옛 데이터·자동 복사가 더하는 필드). */
export interface UpperLimbDiagnosisEntry {
  diagnosisId: string;
  selectedBkType: string;
  bkSelectionMode: string;
  bkAutoSyncedFrom?: string;
  exposure_types: string[];
  bk2103_tool_pressing: string;
  bk2103_frequent_high_force_grip: string;
  [field: string]: unknown;
}

export interface UpperLimbTemporalSequence {
  recent_task_change: string;
  task_change_date: string;
  symptom_onset_interval: string;
  improves_with_rest: string;
}

export interface UpperLimbJobEvaluation {
  sharedJobId: string;
  diagnosisEntries: UpperLimbDiagnosisEntry[];
  _pendingPreset?: Record<string, unknown>;
  [field: string]: unknown;
}

/** 저장된 모듈 데이터(옛 형식 포함 — temporalRelation·diagnosisEvaluations). */
export interface UpperLimbModuleDataInput {
  returnConsiderations?: string;
  temporalSequence?: Partial<UpperLimbTemporalSequence>;
  temporalRelation?: Partial<UpperLimbTemporalSequence>;
  jobEvaluations?: UpperLimbJobEvaluation[];
  diagnosisEvaluations?: Array<Partial<UpperLimbDiagnosisEntry> & { diagnosisId: string; linkedJobId?: string }>;
}

export interface UpperLimbModuleData {
  returnConsiderations: string;
  temporalSequence: UpperLimbTemporalSequence;
  jobEvaluations: UpperLimbJobEvaluation[];
}

/** 엔트리 필드의 빈 값 — 'text'는 '', 'list'는 새 []. */
export type UpperLimbEntryFieldKind = 'text' | 'list';

export interface UpperLimbDataConfig<K extends string> {
  /** 엔트리의 필드(diagnosisId·selectedBkType·bkSelectionMode 다음)와 순서. */
  entryFields: ReadonlyArray<readonly [string, UpperLimbEntryFieldKind]>;
  branchFields: Record<string, string[]>;
  exposureTypeOptions: ReadonlyArray<{ value: string }>;
  inferBkType(diagnosis?: UpperLimbDiagnosisLike): string;
  isDiagnosis(diag: UpperLimbDiagnosisLike, activeModules?: string[]): boolean;
  toolPressingSources: readonly string[];
  diagnosesKey: K;
}

export type UpperLimbSyncResult<K extends string> = {
  [key in K]: Array<UpperLimbDiagnosisLike & { id: string }>;
} & {
  changed: boolean;
  moduleData: UpperLimbModuleData;
};

const BK_GROUP_META_FIELDS = new Set(['diagnosisId', 'selectedBkType', 'bkSelectionMode', 'bkAutoSyncedFrom']);

function serialize(value: unknown) {
  return stableStringify(value || null);
}

function scoreDiagnosisEntry(entry: UpperLimbDiagnosisEntry | undefined): number {
  if (!entry) return 0;
  return Object.entries(entry).filter(([key, value]) =>
    !BK_GROUP_META_FIELDS.has(key) &&
    value !== '' && value !== null &&
    !(Array.isArray(value) && value.length === 0)
  ).length;
}

export function createUpperLimbTemporalSequence(): UpperLimbTemporalSequence {
  return {
    recent_task_change: '',
    task_change_date: '',
    symptom_onset_interval: '',
    improves_with_rest: '',
  };
}

export function createUpperLimbJobEvaluation(sharedJobId = ''): UpperLimbJobEvaluation {
  return {
    sharedJobId,
    diagnosisEntries: [],
  };
}

export function createUpperLimbModuleData(): UpperLimbModuleData {
  return {
    returnConsiderations: '',
    temporalSequence: createUpperLimbTemporalSequence(),
    jobEvaluations: [],
  };
}

/** 모듈 config로 엔트리 팩토리·분기 초기화·sync를 만든다. */
export function createUpperLimbDataApi<K extends string>(config: UpperLimbDataConfig<K>) {
  function createDiagnosisEntry(diagnosis: UpperLimbDiagnosisLike = {}): UpperLimbDiagnosisEntry {
    const inferredBkType = config.inferBkType(diagnosis);
    const entry: UpperLimbDiagnosisEntry = {
      diagnosisId: diagnosis.id || '',
      selectedBkType: inferredBkType,
      bkSelectionMode: 'auto',
    } as UpperLimbDiagnosisEntry;
    for (const [field, kind] of config.entryFields) entry[field] = kind === 'list' ? [] : '';
    return entry;
  }

  function createDiagnosisEvaluation(diagnosisId = ''): UpperLimbDiagnosisEntry {
    return createDiagnosisEntry({ id: diagnosisId });
  }

  function resetBranchFields(entry: Partial<UpperLimbDiagnosisEntry> = {}, nextBkType = ''): Partial<UpperLimbDiagnosisEntry> {
    const nextEntry: Partial<UpperLimbDiagnosisEntry> = { ...entry, selectedBkType: nextBkType };

    Object.values(config.branchFields).flat().forEach(fieldName => {
      nextEntry[fieldName] = Array.isArray(nextEntry[fieldName]) ? [] : '';
    });

    return nextEntry;
  }

  function normalizeTemporalSequence(moduleData: UpperLimbModuleDataInput = {}): UpperLimbTemporalSequence {
    return {
      ...createUpperLimbTemporalSequence(),
      ...(moduleData.temporalSequence || moduleData.temporalRelation || {}),
    };
  }

  function buildLegacyEntryMap(moduleData: UpperLimbModuleDataInput = {}, jobs: UpperLimbJobLike[] = [], diagnoses: UpperLimbDiagnosisLike[] = []) {
    const legacyMap = new Map<string, UpperLimbDiagnosisEntry>();
    const firstJobId = jobs[0]?.id || '';
    const legacyDiagnoses = Array.isArray(moduleData.diagnosisEvaluations)
      ? moduleData.diagnosisEvaluations
      : [];

    legacyDiagnoses.forEach(legacyEntry => {
      const diagnosis = diagnoses.find(item => item.id === legacyEntry.diagnosisId) || { id: legacyEntry.diagnosisId };
      const sharedJobId = legacyEntry.linkedJobId || firstJobId;
      if (!sharedJobId || !legacyEntry.diagnosisId) return;

      const nextEntry: UpperLimbDiagnosisEntry = {
        ...createDiagnosisEntry(diagnosis),
        ...legacyEntry,
        diagnosisId: legacyEntry.diagnosisId,
        bkSelectionMode: legacyEntry.selectedBkType ? 'manual' : 'auto',
      };
      legacyMap.set(`${sharedJobId}:${legacyEntry.diagnosisId}`, nextEntry);
    });

    return legacyMap;
  }

  function normalizeDiagnosisEntry(existingEntry: UpperLimbDiagnosisEntry | undefined, diagnosis: UpperLimbDiagnosisLike & { id: string }): UpperLimbDiagnosisEntry {
    const baseEntry: UpperLimbDiagnosisEntry = {
      ...createDiagnosisEntry(diagnosis),
      ...(existingEntry || {}),
      diagnosisId: diagnosis.id,
    };
    baseEntry.exposure_types = (baseEntry.exposure_types || []).filter(value =>
      config.exposureTypeOptions.some(option => option.value === value)
    );

    const inferredBkType = config.inferBkType(diagnosis);
    const selectionMode = baseEntry.bkSelectionMode === 'manual' ? 'manual' : 'auto';

    if (selectionMode === 'auto') {
      baseEntry.selectedBkType = inferredBkType;
      baseEntry.bkSelectionMode = 'auto';
    } else if (!baseEntry.selectedBkType) {
      baseEntry.selectedBkType = inferredBkType;
      baseEntry.bkSelectionMode = 'auto';
    } else {
      baseEntry.bkSelectionMode = 'manual';
    }

    // 고힘 그립 등 근거 필드가 'yes'면 비어 있는 공구 압박을 'yes'로 채운다(근거 필드는 모듈마다 다르다).
    if (!baseEntry.bk2103_tool_pressing && config.toolPressingSources.some(field => baseEntry[field] === 'yes')) {
      baseEntry.bk2103_tool_pressing = 'yes';
    }

    return baseEntry;
  }

  function syncModuleData(
    moduleData: UpperLimbModuleDataInput = {},
    jobs: UpperLimbJobLike[] = [],
    diagnoses: Array<UpperLimbDiagnosisLike & { id: string }> | null = [],
    activeModules: string[] = [],
  ): UpperLimbSyncResult<K> {
    const moduleDiagnoses = (diagnoses || []).filter(diag => config.isDiagnosis(diag, activeModules));
    const temporalSequence = normalizeTemporalSequence(moduleData);
    const legacyEntryMap = buildLegacyEntryMap(moduleData, jobs, moduleDiagnoses);
    const existingJobMap = new Map<string, UpperLimbJobEvaluation>(
      (moduleData.jobEvaluations || []).map(jobEvaluation => [jobEvaluation.sharedJobId, jobEvaluation])
    );

    const nextJobEvaluations = (jobs || []).map(job => {
      const existingJobEvaluation = existingJobMap.get(job.id);
      const pendingPreset = existingJobEvaluation?._pendingPreset;
      const existingEntryMap = new Map<string, UpperLimbDiagnosisEntry>(
        (existingJobEvaluation?.diagnosisEntries || []).map(entry => [entry.diagnosisId, entry])
      );

      const diagnosisEntries = moduleDiagnoses.map(diagnosis => {
        const existingEntry = existingEntryMap.get(diagnosis.id) || legacyEntryMap.get(`${job.id}:${diagnosis.id}`);
        const entry = normalizeDiagnosisEntry(existingEntry, diagnosis);
        // _pendingPreset이 있고 기존 엔트리가 없으면 프리셋 공통 필드 적용
        if (!existingEntry && pendingPreset) {
          for (const key of Object.keys(pendingPreset)) {
            if (key in entry && pendingPreset[key] !== undefined) {
              entry[key] = pendingPreset[key];
            }
          }
        }
        // 신규 생성 entry뿐 아니라, 진단 코드 변경으로 자동추론 BK유형이 바뀐 기존 entry도 동기화 대상에 포함한다.
        const bkTypeJustChanged = !!existingEntry && existingEntry.selectedBkType !== entry.selectedBkType;
        return { entry, autoSyncEligible: !existingEntry || bkTypeJustChanged };
      });

      // 아직 아무 값도 입력되지 않은 entry가 이미 값이 채워진 동일 BK유형 entry와 같은 그룹으로 묶이면
      // (화면엔 대표값이 채워진 것처럼 보이지만 실제 저장값은 비어있는 상태를 방지하기 위해) 대표값을 즉시 복사한다.
      diagnosisEntries.forEach(({ entry, autoSyncEligible }) => {
        if (!autoSyncEligible || !entry.selectedBkType || scoreDiagnosisEntry(entry) > 0) return;
        const donor = diagnosisEntries.reduce<(typeof diagnosisEntries)[number] | null>((best, other) => {
          if (other.entry === entry || other.entry.selectedBkType !== entry.selectedBkType) return best;
          const score = scoreDiagnosisEntry(other.entry);
          if (score === 0) return best;
          if (!best || score > scoreDiagnosisEntry(best.entry)) return other;
          return best;
        }, null);
        if (!donor) return;
        Object.entries(donor.entry).forEach(([key, value]) => {
          if (BK_GROUP_META_FIELDS.has(key)) return;
          entry[key] = Array.isArray(value) ? [...value] : value;
        });
        entry.bkAutoSyncedFrom = donor.entry.diagnosisId;
      });

      const { _pendingPreset, ...restJobEval } = (existingJobEvaluation || {}) as Partial<UpperLimbJobEvaluation>;
      return {
        ...createUpperLimbJobEvaluation(job.id),
        ...restJobEval,
        sharedJobId: job.id,
        diagnosisEntries: diagnosisEntries.map(({ entry }) => entry),
      };
    });

    const nextModuleData: UpperLimbModuleData = {
      returnConsiderations: moduleData?.returnConsiderations || '',
      temporalSequence,
      jobEvaluations: nextJobEvaluations,
    };

    const currentJobEvaluations = Array.isArray(moduleData.jobEvaluations)
      ? moduleData.jobEvaluations.map(jobEvaluation => ({
        ...jobEvaluation,
        diagnosisEntries: (jobEvaluation.diagnosisEntries || []).map(entry => ({ ...entry })),
      }))
      : jobs
        .map(job => {
          const legacyEntries = moduleDiagnoses
            .map(diagnosis => legacyEntryMap.get(`${job.id}:${diagnosis.id}`))
            .filter(Boolean);

          if (legacyEntries.length === 0) return null;

          return {
            sharedJobId: job.id,
            diagnosisEntries: legacyEntries.map(entry => ({ ...entry })),
          };
        })
        .filter(Boolean);

    const currentComparable = {
      returnConsiderations: moduleData?.returnConsiderations || '',
      temporalSequence,
      jobEvaluations: currentJobEvaluations,
    };

    // 상병 목록이 반환 객체의 첫 키다(옛 코드의 { elbowDiagnoses, changed, moduleData } 순서).
    return {
      [config.diagnosesKey]: moduleDiagnoses,
      changed: serialize(currentComparable) !== serialize(nextModuleData),
      moduleData: nextModuleData,
    } as UpperLimbSyncResult<K>;
  }

  return { createDiagnosisEntry, createDiagnosisEvaluation, resetBranchFields, syncModuleData };
}
