import { useEffect } from 'react';

// Electron 메뉴 이벤트
export function useElectronMenuEvents({ handleResetPatientsRef, handleStartIntakeRef }) {
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.onMenuNew) {
      unsubs.push(window.electron.onMenuNew(() => { handleResetPatientsRef.current?.(); }));
    }
    if (window.electron?.onGotoModule) {
      unsubs.push(window.electron.onGotoModule(() => { handleStartIntakeRef.current?.(); }));
    }
    return () => unsubs.forEach(fn => fn?.());
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}
