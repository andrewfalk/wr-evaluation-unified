import { useEffect } from 'react';
import { getMenuBridge } from '../../platform/bridge';

// Electron 메뉴 이벤트
export function useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef, handleOpenStatisticsRef }) {
  useEffect(() => {
    const unsubs = [];
    const menu = getMenuBridge();
    if (menu?.onMenuNew) {
      unsubs.push(menu.onMenuNew(() => { handleResetPatientsRef.current?.(); }));
    }
    if (menu?.onGotoModule) {
      unsubs.push(menu.onGotoModule(() => { handleStartIntakeRef.current?.(); }));
    }
    // PR2 §3 — 통계분석 워크벤치 메뉴 클릭.
    if (menu?.onOpenStatistics) {
      unsubs.push(menu.onOpenStatistics(() => { handleOpenStatisticsRef.current?.(); }));
    }
    return () => unsubs.forEach(fn => fn?.());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
