// 모듈 매니페스트 — 평가 모듈이 registerModule()로 내는 정보의 모양과 검사(REFACTORING_ROADMAP Phase 2 C5, P2-49).
//
// 모듈 파일(src/modules/*/index.js)은 아직 JS라 이 타입을 직접 쓰지 않는다. 대신 등록할 때 validateManifest()가
// 같은 모양을 실행 중에 확인한다 — 타입과 검사가 같은 목록(MANIFEST_KEYS 등)을 보도록 이 파일 하나에 둔다.
// 새 최상위 키는 그 키를 쓰기 시작하는 PR에서 MANIFEST_KEYS에 더한다(계획 phase2-c5c6-plan.md 원칙 4).
import type { ComponentType } from 'react';

/** 평가 화면 탭 — 모듈마다 단계(step) 하나씩이 된다(src/core/utils/steps.js). */
export interface ModuleTab {
  id: string;
  label: string;
}

/** 평가 화면(StepContent가 그린다)이 받는 props. 모듈마다 쓰는 것만 골라 쓴다. */
export interface ModuleEvaluationProps {
  patient: unknown;
  calc: unknown;
  updateModule: (updater: unknown) => void;
  activeTab?: string;
  errors?: unknown;
  canMutate?: boolean;
  [prop: string]: unknown;
}

export const PRESET_FIELD_TYPES = ['number', 'boolean', 'string'] as const;
export type PresetFieldType = (typeof PRESET_FIELD_TYPES)[number];

/** 프리셋 필드 한 개 — 프리셋 저장 창이 라벨·값 줄로 그린다. */
export interface PresetFieldDef {
  key: string;
  label: string;
  type: PresetFieldType;
}

/** 직업 노출 프리셋 연동(선택). fields가 'tasks'이면 작업 목록형(spine·cervical). */
export interface PresetConfig {
  label: string;
  fields: PresetFieldDef[] | 'tasks';
  extractFromModule(moduleData: unknown, sharedJobId: string): unknown;
  applyToModule(moduleData: unknown, sharedJobId: string, presetData: unknown): unknown;
}

/** 일괄 가져오기(BatchImportModal) 행 하나를 모듈에 반영할 때 받는 값. */
export interface BatchImportRowContext {
  patient: unknown;
  row: unknown[];
  diagnosis: unknown;
  job: unknown;
  colMap: Record<string, number | undefined>;
  getCell: (row: unknown[], index: number | undefined) => unknown;
  rowIndex: number;
}

/** 일괄 가져오기 연동(선택). columns = 열 키 → 엑셀 머리글 후보. */
export interface BatchImportConfig {
  columns: Record<string, string[]>;
  applyRow(context: BatchImportRowContext): void;
}

export const VIDEO_MAPPING_SCOPES = ['job', 'task', 'job-diagnosis'] as const;
export type VideoMappingScope = (typeof VIDEO_MAPPING_SCOPES)[number];

/** 영상 분석 자동 매핑(선택, §8.10). 선언하지 않은 모듈은 자동 입력 대상에서 빠진다(수기만, §8.15). */
export interface VideoMappingConfig {
  /** 적용 단위(jobExtras / tasks / 진단별) */
  scope: VideoMappingScope;
  /** 이 모듈이 소비하는 FeatureKey(자동제안 대상, candidate 제외) */
  featureKeys: string[];
  /** 모듈 필드 타입으로 변환(String/number) */
  coerce?: (featureKey: string, value: unknown) => unknown;
  /** 원자값 기입(불변) — { moduleData, previousValue, targetPath } */
  writeField(moduleData: unknown, ctx: unknown, featureKey: string, value: unknown): unknown;
  /** task 범위에서 직업 미연결 레거시 task도 대상 후보로 허용(spine) */
  taskFallbackUnlinked?: boolean;
}

export interface ModuleManifest {
  id: string;
  name: string;
  icon: string;
  description: string;
  EvaluationComponent: ComponentType<ModuleEvaluationProps>;
  createModuleData(): unknown;
  computeCalc(context: unknown): unknown;
  isComplete(context: unknown): boolean;
  tabs: ModuleTab[];
  presetConfig?: PresetConfig;
  batchImportConfig?: BatchImportConfig;
  videoMappingConfig?: VideoMappingConfig;
}

export const REQUIRED_MANIFEST_KEYS = [
  'id', 'name', 'icon', 'description', 'EvaluationComponent', 'createModuleData', 'computeCalc', 'isComplete', 'tabs',
] as const;
export const OPTIONAL_MANIFEST_KEYS = ['presetConfig', 'batchImportConfig', 'videoMappingConfig'] as const;
export const MANIFEST_KEYS: readonly string[] = [...REQUIRED_MANIFEST_KEYS, ...OPTIONAL_MANIFEST_KEYS];

const PRESET_CONFIG_KEYS: readonly string[] = ['label', 'fields', 'extractFromModule', 'applyToModule'];
const PRESET_FIELD_KEYS: readonly string[] = ['key', 'label', 'type'];
const BATCH_IMPORT_CONFIG_KEYS: readonly string[] = ['columns', 'applyRow'];
const VIDEO_MAPPING_CONFIG_KEYS: readonly string[] = ['scope', 'featureKeys', 'coerce', 'writeField', 'taskFallbackUnlinked'];

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** React가 그릴 수 있는 컴포넌트(함수·클래스, 또는 memo·lazy·forwardRef가 만든 객체). */
function isComponent(value: unknown): boolean {
  return typeof value === 'function' || (isRecord(value) && '$$typeof' in value);
}

function unknownKeys(value: Fields, allowed: readonly string[]): string[] {
  return Object.keys(value).filter(key => !allowed.includes(key));
}

function checkPresetConfig(config: unknown, problems: string[]): void {
  if (!isRecord(config)) {
    problems.push('presetConfig는 객체여야 합니다');
    return;
  }
  for (const key of unknownKeys(config, PRESET_CONFIG_KEYS)) problems.push(`presetConfig에 모르는 키 '${key}'`);
  if (!isNonEmptyString(config.label)) problems.push('presetConfig.label은 빈 문자열이 아닌 문자열이어야 합니다');
  const { fields } = config;
  if (fields !== 'tasks') {
    if (!Array.isArray(fields)) {
      problems.push("presetConfig.fields는 배열이거나 'tasks'여야 합니다");
    } else {
      fields.forEach((field: unknown, index) => {
        const where = `presetConfig.fields[${index}]`;
        if (!isRecord(field)) {
          problems.push(`${where}는 객체여야 합니다`);
          return;
        }
        for (const key of unknownKeys(field, PRESET_FIELD_KEYS)) problems.push(`${where}에 모르는 키 '${key}'`);
        if (!isNonEmptyString(field.key)) problems.push(`${where}.key는 빈 문자열이 아닌 문자열이어야 합니다`);
        if (!isNonEmptyString(field.label)) problems.push(`${where}.label은 빈 문자열이 아닌 문자열이어야 합니다`);
        if (!(PRESET_FIELD_TYPES as readonly unknown[]).includes(field.type)) {
          problems.push(`${where}.type은 ${PRESET_FIELD_TYPES.join('·')} 중 하나여야 합니다`);
        }
      });
    }
  }
  if (typeof config.extractFromModule !== 'function') problems.push('presetConfig.extractFromModule은 함수여야 합니다');
  if (typeof config.applyToModule !== 'function') problems.push('presetConfig.applyToModule은 함수여야 합니다');
}

function checkBatchImportConfig(config: unknown, problems: string[]): void {
  if (!isRecord(config)) {
    problems.push('batchImportConfig는 객체여야 합니다');
    return;
  }
  for (const key of unknownKeys(config, BATCH_IMPORT_CONFIG_KEYS)) problems.push(`batchImportConfig에 모르는 키 '${key}'`);
  if (!isRecord(config.columns)) {
    problems.push('batchImportConfig.columns는 객체여야 합니다');
  } else {
    for (const [key, candidates] of Object.entries(config.columns)) {
      if (!isStringArray(candidates) || candidates.length === 0) {
        problems.push(`batchImportConfig.columns.${key}는 비어 있지 않은 문자열 배열이어야 합니다`);
      }
    }
  }
  if (typeof config.applyRow !== 'function') problems.push('batchImportConfig.applyRow는 함수여야 합니다');
}

function checkVideoMappingConfig(config: unknown, problems: string[]): void {
  if (!isRecord(config)) {
    problems.push('videoMappingConfig는 객체여야 합니다');
    return;
  }
  for (const key of unknownKeys(config, VIDEO_MAPPING_CONFIG_KEYS)) problems.push(`videoMappingConfig에 모르는 키 '${key}'`);
  if (!(VIDEO_MAPPING_SCOPES as readonly unknown[]).includes(config.scope)) {
    problems.push(`videoMappingConfig.scope는 ${VIDEO_MAPPING_SCOPES.join('·')} 중 하나여야 합니다`);
  }
  if (!isStringArray(config.featureKeys)) problems.push('videoMappingConfig.featureKeys는 문자열 배열이어야 합니다');
  if (config.coerce !== undefined && typeof config.coerce !== 'function') {
    problems.push('videoMappingConfig.coerce는 함수여야 합니다');
  }
  if (typeof config.writeField !== 'function') problems.push('videoMappingConfig.writeField는 함수여야 합니다');
  if (config.taskFallbackUnlinked !== undefined && typeof config.taskFallbackUnlinked !== 'boolean') {
    problems.push('videoMappingConfig.taskFallbackUnlinked는 불리언이어야 합니다');
  }
}

/**
 * 매니페스트의 문제 목록(없으면 빈 배열). 순수 함수 — 등록 여부는 레지스트리(registry.ts)가 정한다.
 * 문장 앞에 모듈 id를 붙이지 않는다(레지스트리가 붙인다).
 */
export function validateManifest(manifest: unknown): string[] {
  if (!isRecord(manifest)) return ['매니페스트는 객체여야 합니다'];
  const problems: string[] = [];
  for (const key of REQUIRED_MANIFEST_KEYS) {
    if (!(key in manifest) || manifest[key] === undefined) problems.push(`필수 키 '${key}'가 없습니다`);
  }
  for (const key of unknownKeys(manifest, MANIFEST_KEYS)) problems.push(`모르는 키 '${key}'`);

  const { id, name, icon, description, EvaluationComponent, tabs } = manifest;
  if (id !== undefined && !isNonEmptyString(id)) problems.push('id는 빈 문자열이 아닌 문자열이어야 합니다');
  if (name !== undefined && !isNonEmptyString(name)) problems.push('name은 빈 문자열이 아닌 문자열이어야 합니다');
  if (icon !== undefined && typeof icon !== 'string') problems.push('icon은 문자열이어야 합니다');
  if (description !== undefined && typeof description !== 'string') problems.push('description은 문자열이어야 합니다');
  if (EvaluationComponent !== undefined && !isComponent(EvaluationComponent)) {
    problems.push('EvaluationComponent는 React 컴포넌트여야 합니다');
  }
  for (const key of ['createModuleData', 'computeCalc', 'isComplete'] as const) {
    if (manifest[key] !== undefined && typeof manifest[key] !== 'function') problems.push(`${key}는 함수여야 합니다`);
  }
  if (tabs !== undefined) {
    if (!Array.isArray(tabs) || tabs.length === 0) {
      problems.push('tabs는 비어 있지 않은 배열이어야 합니다');
    } else {
      tabs.forEach((tab: unknown, index) => {
        if (!isRecord(tab) || !isNonEmptyString(tab.id) || !isNonEmptyString(tab.label)) {
          problems.push(`tabs[${index}]는 { id, label } 문자열 객체여야 합니다`);
        }
      });
    }
  }
  if (manifest.presetConfig !== undefined) checkPresetConfig(manifest.presetConfig, problems);
  if (manifest.batchImportConfig !== undefined) checkBatchImportConfig(manifest.batchImportConfig, problems);
  if (manifest.videoMappingConfig !== undefined) checkVideoMappingConfig(manifest.videoMappingConfig, problems);
  return problems;
}
