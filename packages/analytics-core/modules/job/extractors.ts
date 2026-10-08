// Raw extractor — job grain 1호 슬라이스(§5.5 ①, §2.1). job.identity.* 2개(변수 추가/제거
// 시 모집단 불변 계약을 이 grain에서도 증명하려면 최소 2개 필요, vibration_interval/
// diagnosis_side와 동일한 이유) + job.rollup.longestTenureJobNameNormalized(§2.1 최초
// roll-up 구현, case grain).

import type { ExtractedValue, MigrationResult, RepeatedObservation } from '../../types';
import { parseStrictIsoDate, compareDate } from '../../dates';
import { computeJobTenureYears } from '../../jobTenure';
import { enumerateJobEntities, type JobEntitySource } from '../../grainEntities';
import type { GrainEntity } from '../../types';
import type { AnalysisPatient } from '../../migration/deterministicMigrate';

function isBlank(x: unknown): boolean {
  return x === null || x === undefined || String(x).trim() === '';
}

// §5.5 ① 계획 규칙 그대로 — NFC → 앞뒤 공백 제거 → 내부 연속 공백 1칸 → 전각/반각 통일 →
// 영문 소문자화. 원본 jobName은 절대 덮어쓰지 않는다(이 함수는 파생값만 만든다) —
// isBlank(raw)를 이미 통과한 non-blank 문자열만 받는다는 게 호출부의 전제.
// PR0-B4 Slice 8b — elbow/wrist의 main_task_name(job_diagnosis grain, quasi_identifier)이
// "job.identity.jobNameNormalized 선례 재사용"으로 이 함수를 그대로 가져다 쓴다(재구현 금지).
export function normalizeJobName(raw: string): string {
  const nfc = raw.normalize('NFC');
  const trimmed = nfc.trim();
  const collapsed = trimmed.replace(/\s+/g, ' ');
  // 전각(U+FF01~FF5E) → 반각(U+0021~007E) — 코드포인트를 0xFEE0만큼 이동.
  const halfwidth = collapsed.replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0));
  return halfwidth.toLowerCase();
}

// 원본이 문자열이 아니면(배열·숫자·boolean 등) parseStrictIsoDate에 String()으로 흘려
// 넣지 않는다 — String(['2020-01-01'])==='2020-01-01'처럼 우연히 유효한 형식으로
// 강제변환되는 경로를 원천적으로 막는다(K-L Grade/spine 공통필드에서 이미 확립한 원칙).
function tryParseStrictDate(raw: unknown) {
  if (typeof raw !== 'string') return null;
  return parseStrictIsoDate(raw);
}

export function extractJobIdentityJobNameNormalized(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<string>[] {
  return enumerateJobEntities(migrationResult).map((entity) => {
    const raw = entity.source.jobName;
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (typeof raw !== 'string') {
      return {
        entityKey: entity.entityKey,
        value: null,
        missing: 'not_entered',
        qualityFlags: [...entity.qualityFlags, 'invalid'],
      };
    }
    return { entityKey: entity.entityKey, value: normalizeJobName(raw), missing: null, qualityFlags: entity.qualityFlags };
  });
}

export function extractJobIdentityTenureYears(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<number>[] {
  return enumerateJobEntities(migrationResult).map((entity) => {
    const result = computeJobTenureYears(entity.source);
    if (result.kind === 'blank') {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (result.kind === 'invalid') {
      return {
        entityKey: entity.entityKey,
        value: null,
        missing: 'not_entered',
        qualityFlags: [...entity.qualityFlags, 'invalid'],
      };
    }
    return { entityKey: entity.entityKey, value: result.years, missing: null, qualityFlags: entity.qualityFlags };
  });
}

interface TenureCandidate {
  entity: GrainEntity<JobEntitySource>;
  years: number;
}

// §2.1 계획 — job grain 값을 case로 올릴 때의 기본 대표 규칙("대표 직력 기본값 = 근속
// 최장, 결정 완료"). 근속기간이 결측/무효인 job은 후보에서 제외하고, 전부 그러면
// null(대표 job 없음). 동률 tie-break: 시작일 이른 순 → jobId 사전순.
// job.rollup.longestTenureJobNameNormalized(대표 직종명)와 job.rollup.longestTenureYears
// (대표 근속기간, 아래)가 이 선택을 공유한다 — 둘을 따로 계산하면 "대표 직력이 누구인가"에
// 대해 서로 다른 답이 나올 수 있다(예: tie-break 로직이 갈라지는 버그).
function resolveRepresentativeJob(migrationResult: MigrationResult<AnalysisPatient>): TenureCandidate | null {
  const entities = enumerateJobEntities(migrationResult);
  const candidates: TenureCandidate[] = [];
  for (const entity of entities) {
    const result = computeJobTenureYears(entity.source);
    if (result.kind === 'ok') candidates.push({ entity, years: result.years });
  }
  if (candidates.length === 0) return null;

  // 4차 리뷰 P2 — 근속이 workPeriodOverride로 계산된 후보는 startDate가 아예 없을 수
  // 있다(값 계산에 안 쓰였으므로). 문자열 비교(String(undefined??'')==='')로 시작일을
  // 비교하면 빈 문자열이 사전순으로 모든 실제 날짜보다 앞에 와서 "시작일 미입력"이
  // "시작일이 가장 이름"으로 둔갑한다 — 유효 날짜가 있는 후보를 항상 먼저 우선하고,
  // 둘 다 유효 날짜가 없을 때만(또는 둘 다 있고 같을 때) jobId로 넘어간다.
  candidates.sort((a, b) => {
    if (b.years !== a.years) return b.years - a.years;

    const aDate = tryParseStrictDate(a.entity.source.startDate);
    const bDate = tryParseStrictDate(b.entity.source.startDate);
    if (aDate && bDate) {
      const cmp = compareDate(aDate, bDate);
      if (cmp !== 0) return cmp;
    } else if (aDate && !bDate) {
      return -1;
    } else if (!aDate && bDate) {
      return 1;
    }

    const aId = a.entity.entityKey[0];
    const bId = b.entity.entityKey[0];
    return aId < bId ? -1 : aId > bId ? 1 : 0;
  });

  return candidates[0];
}

export function extractJobRollupLongestTenureJobNameNormalized(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<string> {
  const winner = resolveRepresentativeJob(migrationResult);
  if (winner === null) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }
  const rawName = winner.entity.source.jobName;
  if (isBlank(rawName) || typeof rawName !== 'string') {
    // 근속 최장 job은 정해졌지만 그 job의 직종명이 없거나 손상됐다 — 보고할 이름이 없다.
    return { value: null, missing: 'not_entered', qualityFlags: winner.entity.qualityFlags };
  }
  return { value: normalizeJobName(rawName), missing: null, qualityFlags: winner.entity.qualityFlags };
}

// case grain 롤업 — "근속기간(년)"을 max로 case에 올린다(계획서 "Case-grain 롤업 변수
// 3종 추가" 절). 독립적으로 max를 재계산하지 않고 resolveRepresentativeJob이 고른 바로
// 그 job의 연수를 반환한다 — 대표 직종명과 대표 근속기간이 항상 같은 job에서 나오도록
// 보장한다. winner가 있으면 그 job의 tenure는 항상 TenureResult.kind==='ok'였던
// 것이므로(후보 선정 조건) 여기서 blank/invalid 분기가 따로 필요 없다.
export function extractJobRollupLongestTenureYears(
  migrationResult: MigrationResult<AnalysisPatient>,
): ExtractedValue<number> {
  const winner = resolveRepresentativeJob(migrationResult);
  if (winner === null) {
    return { value: null, missing: 'not_entered', qualityFlags: [] };
  }
  return { value: winner.years, missing: null, qualityFlags: winner.entity.qualityFlags };
}

// ── PR0-B4 Slice 2 — coverage 잔여 필드(매핑표 §1 shared.jobs[]). tenureYears/rollup의
// dependsOn에만 있던 raw 필드를 독립 노출한다.

// job.raw.startDate/endDate — 카탈로그 최초의 date 타입 analytics-core 변수(서버 전용
// SNAPSHOT_COLUMN_VARIABLES의 case.meta.registeredAt은 이미 있었다). 값 형식은 그
// 선례와 동일하게 YYYY-MM-DD 문자열을 그대로 쓴다(statsDatasetBuilder.ts의 필터 비교가
// 이 형식을 그대로 문자열 비교하므로, parseStrictIsoDate로 검증만 하고 재포맷하지
// 않는다 — 원본이 이미 그 형식이어야 통과한다).
function extractJobRawDateField(
  migrationResult: MigrationResult<AnalysisPatient>,
  field: 'startDate' | 'endDate',
): RepeatedObservation<string>[] {
  return enumerateJobEntities(migrationResult).map((entity) => {
    const raw = entity.source[field];
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (typeof raw !== 'string' || !parseStrictIsoDate(raw)) {
      return {
        entityKey: entity.entityKey,
        value: null,
        missing: 'not_entered',
        qualityFlags: [...entity.qualityFlags, 'invalid'],
      };
    }
    return { entityKey: entity.entityKey, value: raw, missing: null, qualityFlags: entity.qualityFlags };
  });
}

export function extractJobRawStartDate(migrationResult: MigrationResult<AnalysisPatient>): RepeatedObservation<string>[] {
  return extractJobRawDateField(migrationResult, 'startDate');
}

export function extractJobRawEndDate(migrationResult: MigrationResult<AnalysisPatient>): RepeatedObservation<string>[] {
  return extractJobRawDateField(migrationResult, 'endDate');
}

export function extractJobRawWorkDaysPerYear(
  migrationResult: MigrationResult<AnalysisPatient>,
): RepeatedObservation<number>[] {
  return enumerateJobEntities(migrationResult).map((entity) => {
    const raw = entity.source.workDaysPerYear;
    if (isBlank(raw)) {
      return { entityKey: entity.entityKey, value: null, missing: 'not_entered', qualityFlags: entity.qualityFlags };
    }
    if (typeof raw !== 'number' && typeof raw !== 'string') {
      return {
        entityKey: entity.entityKey,
        value: null,
        missing: 'not_entered',
        qualityFlags: [...entity.qualityFlags, 'invalid'],
      };
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return {
        entityKey: entity.entityKey,
        value: null,
        missing: 'not_entered',
        qualityFlags: [...entity.qualityFlags, 'invalid'],
      };
    }
    return { entityKey: entity.entityKey, value: n, missing: null, qualityFlags: entity.qualityFlags };
  });
}
