import { useEffect } from 'react';

// Electron 메뉴 이벤트
export function useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef }) {
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.onMenuNew) {
      unsubs.push(window.electron.onMenuNew(() => { handleResetPatientsRef.current?.(); }));
    }
    if (window.electron?.onGotoModule) {
      unsubs.push(window.electron.onGotoModule(() => { handleStartIntakeRef.current?.(); }));
    }
    // PR2 §3 — 통계분석 워크벤치 메뉴 클릭.
    if (window.electron?.onOpenStatistics) {
      unsubs.push(window.electron.onOpenStatistics(() => { handleOpenStatisticsRef.current?.(); }));
    }
    return () => unsubs.forEach(fn => fn?.());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
