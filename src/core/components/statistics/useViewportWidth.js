import { useState, useEffect, useRef } from 'react';

// PR2 §10 — 반응형 접힘 임계값 판정용. win7 호환상 ResizeObserver 대신 resize 이벤트를 쓰고
// (§6.8.6 기존 제약과 동일), ~150ms 디바운스로 리사이즈 중 과도한 재계산을 피한다.
export function useViewportWidth() {
  const [width, setWidth] = useState(() => (typeof window !== 'undefined' ? window.innerWidth : 1920));
  const timerRef = useRef(null);

  useEffect(() => {
    function onResize() {
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setWidth(window.innerWidth), 150);
    }
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      clearTimeout(timerRef.current);
    };
  }, []);

  return width;
}
