// 순번 가드(REFACTORING_ROADMAP Phase 2 C9 P2-83b) — 늦게 온 응답과 언마운트 뒤 응답을 버린다.
//
//   const beginLoad = useLatestGuard();
//   const load = async () => {
//     const isLatest = beginLoad();       // 불러오기마다 순번을 하나 올린다
//     …
//     const data = await fetchSomething();
//     if (!isLatest()) return;            // 그 뒤에 새 불러오기가 시작됐거나 언마운트됐으면 상태를 바꾸지 않는다
//     setItems(data.items);
//   };
//
// useAsync와 달리 data·error·loading 상태를 갖지 않는다 — 부르는 쪽의 상태 모양(오류 칸을 행 동작과 같이 쓰는 탭, 불러온 값이
// 편집 폼의 초기값인 탭)을 그대로 두고 "늦은 응답만 버린다". 요청을 끊지는 않는다(끊기는 AbortController의 몫).
// StrictMode: 개발 모드의 effect 재실행(setup → cleanup → setup)에서 마운트 표시를 cleanup에서만 내리면 영영 false로 남으므로
// setup에서도 되살린다.
import { useCallback, useEffect, useRef } from 'react';

/** 불러오기를 시작할 때 부른다. 돌려받은 함수는 그 불러오기가 아직 마지막이고 마운트돼 있으면 true. */
export type BeginLatest = () => () => boolean;

export function useLatestGuard(): BeginLatest {
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  return useCallback(() => {
    seqRef.current += 1;
    const seq = seqRef.current;
    return () => mountedRef.current && seqRef.current === seq;
  }, []);
}
