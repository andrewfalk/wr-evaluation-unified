// 레시피 패널의 파생값(useMemo 9개) — P2-79c에서 RecipePanel 본체의 useMemo를 선언 순서·의존 배열 그대로 옮겼다.
// 본체는 접힘 조기 반환보다 앞에서 이 훅을 부른다(훅 호출 순서 불변).
import { useMemo } from 'react';
import { isGrainCompatible, isPurposeCompatible } from '@wr/analytics-core/common';
import type { CatalogVariable, StatsFilter } from '@wr/contracts/stats';
import { PREDICTION_REGISTERED_AT_KEY } from '../workbenchTransitions';
import { GROUPING_TYPES } from '../labels';
import type { CatalogByKey } from './types';

export interface RecipeDerivedInput {
  catalog: { variables?: CatalogVariable[] } | null | undefined;
  grain: string;
  analysisMode: string;
  selectedKeys: string[];
  filterDraft: StatsFilter[];
  stratifyByKey: string | null;
  analysisPurpose: string;
  outcomeKey: string | null;
}

export interface RecipeDerived {
  catalogByKey: CatalogByKey;
  filterCatalogByKey: CatalogByKey;
  stratifyCandidates: CatalogVariable[];
  formulaFamiliesNeedingChoice: CatalogVariable[];
  predictionOutcomeCandidates: string[];
  predictionPredictorKeys: string[];
  predictionIgnoredKeys: string[];
}

export function useRecipeDerived({
  catalog, grain, analysisMode, selectedKeys, filterDraft, stratifyByKey, analysisPurpose, outcomeKey,
}: RecipeDerivedInput): RecipeDerived {
  const catalogByKey = useMemo(
    () => new Map((catalog?.variables ?? []).map((v) => [v.key, v])),
    [catalog],
  );

  // 필터 후보 = 현재 grain과 호환되는 전체(analysisRole 계약은 별개 — filter_only도
  // 여기선 그대로 둔다). 분석 변수 선택은 CatalogPanel이 이미 grain 호환성으로 거르므로
  // 여기서는 필터 후보만 별도로 좁힌다. grain 단순화(PR0-B4 개정) — 서버와 동일한
  // isGrainCompatible로 case 브로드캐스트 안전 변수도 포함시킨다.
  const grainCatalogByKey = useMemo(
    () => new Map(Array.from(catalogByKey.entries()).filter(([, v]) => isGrainCompatible(v, grain))),
    [catalogByKey, grain],
  );

  // PR4-B2 — 예측 필터는 predictor 역할이거나 등록일(REGISTERED_AT_KEY)만 허용된다
  // (server/src/stats/recipe/validate/prediction.ts PREDICTION_FILTER_LEAKAGE — outcome이나
  // outcome과 얽힌 변수를 필터로 쓰면 결과를 미리 알고 거른 셈이 되는 정보누출을
  // 막는다, 계획서 §0단계 "필터"). 그 외 필터는 여기서 아예 후보에서 뺀다 —
  // "필터를 비활성화할 때 사유를 표시한다"(계획서 §6단계).
  const filterCatalogByKey = useMemo(() => {
    if (analysisMode !== 'prediction') return grainCatalogByKey;
    return new Map(Array.from(grainCatalogByKey.entries()).filter(
      ([k, v]) => v.predictionRole === 'predictor' || k === PREDICTION_REGISTERED_AT_KEY,
    ));
  }, [analysisMode, grainCatalogByKey]);

  // Table1 — 산식 선택 UI(formulaFamiliesNeedingChoice)가 stratifyByKey도 대상에
  // 포함하도록 neededKeys에 추가한다(그룹 변수에 산식 버전이 여러 개면 선택 가능해야
  // 한다). analysisMode!=='descriptive'면 stratifyByKey는 recipe에 실리지 않으므로 제외.
  const neededKeys = useMemo(
    () => Array.from(new Set([
      ...selectedKeys,
      ...filterDraft.map((f) => f.key),
      ...(analysisMode === 'descriptive' && stratifyByKey ? [stratifyByKey] : []),
    ])),
    [selectedKeys, filterDraft, analysisMode, stratifyByKey],
  );

  // Table1 — 그룹 변수 후보: grain 호환 + boolean/ordinal/categorical + 필터 전용
  // 아님 + 이미 분석 변수로 선택된 키 제외(양방향 충돌 방지 — StatisticsWorkbench의
  // toggleVariable 조건부 리셋과 짝을 이룬다).
  const stratifyCandidates = useMemo(() => {
    return Array.from(grainCatalogByKey.values())
      .filter((v) => GROUPING_TYPES.has(v.type) && v.analysisRole !== 'filter_only' && !selectedKeys.includes(v.key)
        // 서버는 stratifyByKey에도 분석 목적을 검사한다(PURPOSE_NOT_ALLOWED) — 선택 자체를 막는다.
        && isPurposeCompatible(v, analysisPurpose))
      .sort((a, b) => a.label.localeCompare(b.label, 'ko'));
  }, [grainCatalogByKey, selectedKeys, analysisPurpose]);

  const formulaFamiliesNeedingChoice = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const key of neededKeys) {
      const v = catalogByKey.get(key);
      if (!v || seen.has(v.formulaFamily)) continue;
      seen.add(v.formulaFamily);
      if (v.supportedFormulaPolicies.length > 1) out.push(v);
    }
    return out;
  }, [neededKeys, catalogByKey]);

  // PR4-B2 — 계획서 §6단계 "outcome과 predictor를 역할별로 필터링한다". CatalogPanel은
  // predictionRole과 무관하게 체크를 허용하므로(회귀와 동일한 원칙 — 역할 제약이 없는
  // 모드도 있다), 여기서 selectedKeys를 역할로 다시 나눈다. StatisticsWorkbench.jsx의
  // predictionEffectiveVariableKeys/isRecipeComplete와 같은 필터 로직이다 — 실제로
  // recipe에 담기는 집합과 화면에 보이는 집합이 어긋나면 안 된다.
  const predictionOutcomeCandidates = useMemo(
    () => selectedKeys.filter((k) => catalogByKey.get(k)?.predictionRole === 'outcome'),
    [selectedKeys, catalogByKey],
  );
  const predictionPredictorKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole === 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );
  const predictionIgnoredKeys = useMemo(
    () => selectedKeys.filter((k) => k !== outcomeKey && catalogByKey.get(k)?.predictionRole !== 'predictor'),
    [selectedKeys, outcomeKey, catalogByKey],
  );

  return {
    catalogByKey, filterCatalogByKey, stratifyCandidates, formulaFamiliesNeedingChoice,
    predictionOutcomeCandidates, predictionPredictorKeys, predictionIgnoredKeys,
  };
}
