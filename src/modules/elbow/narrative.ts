// 팔꿈치 서술 — 소견서·EMR 4번 칸(b6) 공용 전문 블록 · EMR 6번 칸(b8) 요약. 본문은 팔꿈치·손목 공용
// (_shared/upperLimb/narrative, P2-70c — 게이트 C P2-66d에서 맞춘 문구 그대로)이고, 이 모듈은 머리 문자열·BK 유형 라벨·
// 상병 요약 묶기·합치기 함수만 넘긴다. 문구 차이 표의 원본은 narrative.phrases다(P2-65a).
import type { DiagnosisSummary } from '@wr/analytics-core/modules/elbow/index';
import type { ModuleNarrative } from '../../core/modules/manifest';
import { createUpperLimbNarrative } from '../_shared/upperLimb/narrative';
import { groupSummariesByBkType, mergeBkGroupSummaries } from './utils/calculations';
import { BK_TYPE_LABELS } from './utils/data';

export const elbowNarrative: ModuleNarrative = createUpperLimbNarrative<DiagnosisSummary>({
  heading: '\n<팔꿈치(주관절)>\n',
  bkLabels: BK_TYPE_LABELS,
  groupSummaries: groupSummariesByBkType,
  mergeGroups: mergeBkGroupSummaries,
});
