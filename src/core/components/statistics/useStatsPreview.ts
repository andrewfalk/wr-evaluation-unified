// 작업대의 미리보기 요청 — P2-77c에서 StatisticsWorkbench 본체의 상태·effect를 의존 배열·본문 그대로 옮겼다.
// 본문이 본체 값을 직접 읽던 세 곳(완성 판정 · 레시피 만들기 · 기능 비가용 표시)만 렌더마다 새로 넘기는 함수로 받는다 —
// effect가 잡는 것은 그 렌더의 함수이므로 읽는 값은 옛 클로저와 같다.
import { useEffect, useRef, useState } from 'react';
import { previewStatsAnalysis } from '../../services/statsRepository';
import { isFeatureUnavailableError } from './workbenchIo';
import type { RecipePreviewState } from './RecipePanel';
import type { WorkbenchRecipe } from './recipeBuild';

export interface StatsPreviewInput {
  currentConditionKey: string;
  recoveryToken: number;
  session: unknown;
  analysisPurpose: string;
  isComplete: () => boolean;
  buildRequest: () => WorkbenchRecipe;
  onFeatureUnavailable: () => void;
}

export function useStatsPreview({
  currentConditionKey, recoveryToken, session, analysisPurpose, isComplete, buildRequest, onFeatureUnavailable,
}: StatsPreviewInput): { previewState: RecipePreviewState } {
  const [previewState, setPreviewState] = useState<RecipePreviewState>({ key: null, status: 'idle', result: null, error: null });
  const previewGenRef = useRef(0);

  useEffect(() => {
    const key = currentConditionKey;
    const gen = ++previewGenRef.current;
    if (!isComplete()) {
      setPreviewState({ key, status: 'idle', result: null, error: null });
      return undefined;
    }
    setPreviewState({ key, status: 'loading', result: null, error: null });
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        // PR3-A — preview는 requestedMethod를 참고만 하고 유효성을 검사하지 않는다
        // (서버가 관대함, 계획서 §파이프라인 "preview는 관대하다") — method 미선택
        // 상태에서도 이 호출은 정상적으로 나가야 availableMethods를 받아올 수 있다.
        const recipe = buildRequest();
        const res = await previewStatsAnalysis(recipe, session, { signal: controller.signal });
        if (gen !== previewGenRef.current) return;
        setPreviewState((prev) => (prev.key === key ? { key, status: 'ready', result: res, error: null } : prev));
      } catch (err) {
        if ((err as Error | null | undefined)?.name === 'AbortError') return;
        if (isFeatureUnavailableError(err)) onFeatureUnavailable();
        if (gen !== previewGenRef.current) return;
        // 실패한 요청의 목적을 오류와 같이 보관한다 — 오류 문구는 현재 화면 목적이 아니라 요청 목적 기준이다.
        setPreviewState((prev) => (prev.key === key ? { key, status: 'error', result: null, error: err, requestPurpose: analysisPurpose } : prev));
      }
    }, 500);
    return () => { clearTimeout(timer); controller.abort(); };
    // recoveryToken도 의존성에 넣는다 — 조건은 그대로인데 이전 preview가 기능비가용으로
    // 실패했을 때, 재조회 성공 이후 재시도할 유일한 트리거가 이것이다(조건 자체는 안 바뀌므로
    // currentConditionKey만으로는 재실행되지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConditionKey, recoveryToken]);

  return { previewState };
}
