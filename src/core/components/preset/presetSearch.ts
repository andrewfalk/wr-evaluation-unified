// 프리셋 저장 창 조각(P2-88c, Phase 2 C9 구간 A) — PresetManageModal.tsx에서 옮겼다. 비슷한 프리셋 점수·검색 글자·표시값의 순수 함수(본문 그대로).
import type { ReactNode } from 'react';
import {
  DEFAULT_CATEGORY,
  getPresetCategory,
  getPresetDescription,
  normalizePresetIdentityPart,
} from '../../services/presetRepository';

/** 프리셋(직접 만든 것·내장) — 이 창이 직접 읽는 필드. 나머지는 presetRepository(JS)의 함수가 읽는다. */
export interface PresetRecord {
  id?: string;
  _customId?: string;
  _customRevision?: unknown;
  revision?: unknown;
  source?: string;
  jobName?: string;
  modules?: Record<string, unknown>;
}

export interface PresetDraft {
  jobName: string;
  category: string;
  description: string;
}

export function getPresetDraft(preset: PresetRecord | null | undefined): PresetDraft {
  return {
    jobName: preset?.jobName || '',
    category: getPresetCategory(preset) || DEFAULT_CATEGORY,
    description: getPresetDescription(preset),
  };
}

export function normalizeSearchText(value: unknown): string {
  return normalizePresetIdentityPart(value).toLowerCase();
}

export function tokenize(value: unknown): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .filter(token => token.length >= 2);
}

export function formatPresetFieldValue(value: unknown, type: string): ReactNode {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[객체]';
    }
  }
  if (type === 'boolean') {
    return value ? 'Y' : 'N';
  }
  return value as ReactNode;
}

export function getKeywordMatchScore(preset: PresetRecord, draft: PresetDraft): number {
  const presetJob = normalizeSearchText(preset.jobName);
  const presetCategory = normalizeSearchText(getPresetCategory(preset));
  const presetDescription = normalizeSearchText(getPresetDescription(preset));
  const presetBlob = [presetJob, presetCategory, presetDescription].join(' ');

  const draftJob = normalizeSearchText(draft.jobName);
  const draftCategory = normalizeSearchText(draft.category);
  const draftDescription = normalizeSearchText(draft.description);
  const draftTokens = new Set([
    ...tokenize(draft.jobName),
    ...tokenize(draft.category),
    ...tokenize(draft.description),
  ]);

  let score = 0;

  if (draftJob) {
    if (presetJob === draftJob) score += 6;
    else if (presetJob.includes(draftJob) || draftJob.includes(presetJob)) score += 4;
  }

  if (draftCategory) {
    if (presetCategory === draftCategory) score += 4;
    else if (presetCategory.includes(draftCategory) || draftCategory.includes(presetCategory)) score += 2;
  }

  if (draftDescription) {
    if (presetDescription === draftDescription) score += 3;
    else if (presetDescription.includes(draftDescription) || draftDescription.includes(presetDescription)) score += 2;
  }

  for (const token of draftTokens) {
    if (presetBlob.includes(token)) score += 1;
  }

  return score;
}
