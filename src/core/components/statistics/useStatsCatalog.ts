// 작업대의 카탈로그 불러오기 — P2-77c에서 StatisticsWorkbench 본체의 상태·effect를 선언 순서·의존 배열·본문 그대로 옮겼다.
// 본체는 이 훅을 맨 앞(옛 자리)에서 부른다.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { CatalogResponse, CatalogVariable } from '@wr/contracts/stats';
import { fetchStatsCatalog } from '../../services/statsRepository';
import { isFeatureUnavailableError } from './workbenchIo';

export interface StatsCatalogState {
  status: string;
  data: CatalogResponse | null;
  error: unknown;
}

export interface StatsCatalogInput {
  session: unknown;
  statsAvailable: boolean;
  configRefreshing: boolean;
  configRefreshError: unknown;
}

export interface StatsCatalogApi {
  catalogState: StatsCatalogState;
  catalogByKey: Map<string, CatalogVariable>;
  featureUnavailableDetected: boolean;
  setFeatureUnavailableDetected: Dispatch<SetStateAction<boolean>>;
  recoveryToken: number;
  setRecoveryToken: Dispatch<SetStateAction<number>>;
}

export function useStatsCatalog({ session, statsAvailable, configRefreshing, configRefreshError }: StatsCatalogInput): StatsCatalogApi {
  const [catalogState, setCatalogState] = useState<StatsCatalogState>({ status: 'loading', data: null, error: null });
  const [featureUnavailableDetected, setFeatureUnavailableDetected] = useState(false);

  // 1차 리뷰가 잡은 결함 — statsAvailable "값"만 보고 배너를 내리면, config가 이미 true로
  // 저장된 상태에서(일시적 404 → 배너 표시 → 서버 복구 → 재조회도 true) true→true라
  // effect가 재실행되지 않아 배너가 안 내려가고, 카탈로그·preview도 마운트/조건 변경 시에만
  // 재요청되므로 최초 실패가 그대로 남는다. "재조회가 방금 끝났다"는 사건(configRefreshing의
  // true→false 하강 엣지) 자체를 감지해 recoveryToken을 올리고, 카탈로그·preview 둘 다 이
  // 토큰을 의존성에 포함시켜 값이 안 바뀌어도 재시도되게 한다.
  //
  // 2차 리뷰가 잡은 결함 — useServerConfig.js의 refetchConfig()는 실패 시 state.config를
  // 그대로 둔다(§4 설계 — 오래된 응답이 최신 상태를 덮지 않게). 즉 statsAvailable이 true인
  // 채로 재조회가 "실패"해도(configRefreshing: true→false는 성공·실패 모두에서 일어남)
  // statsAvailable 값만 보면 여전히 true라 그 실패까지 복구로 오인했다 — 재조회가 실제로
  // 성공했을 때(configRefreshError가 비어있을 때)만 복구로 인정한다.
  const [recoveryToken, setRecoveryToken] = useState(0);
  const wasRefreshingRef = useRef(configRefreshing);
  useEffect(() => {
    const wasRefreshing = wasRefreshingRef.current;
    wasRefreshingRef.current = configRefreshing;
    if (wasRefreshing && !configRefreshing && statsAvailable && !configRefreshError) {
      setFeatureUnavailableDetected(false);
      setRecoveryToken((t) => t + 1);
    }
  }, [configRefreshing, statsAvailable, configRefreshError]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setCatalogState({ status: 'loading', data: null, error: null });
    fetchStatsCatalog(session, { signal: controller.signal })
      .then((data) => { if (!cancelled) setCatalogState({ status: 'ready', data, error: null }); })
      .catch((err) => {
        if (cancelled) return;
        if (isFeatureUnavailableError(err)) setFeatureUnavailableDetected(true);
        setCatalogState({ status: 'error', data: null, error: err });
      });
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoveryToken]);

  const catalogByKey = useMemo(
    () => new Map((catalogState.data?.variables ?? []).map((v) => [v.key, v])),
    [catalogState.data],
  );

  return { catalogState, catalogByKey, featureUnavailableDetected, setFeatureUnavailableDetected, recoveryToken, setRecoveryToken };
}
