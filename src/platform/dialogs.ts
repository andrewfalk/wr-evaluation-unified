// 크로스 플랫폼 alert/confirm — REFACTORING_ROADMAP Phase 2 C1(P2-10). 셸이면 네이티브 대화상자(IPC), 웹이면 브라우저.
// src/core/utils/platform.js는 이 파일을 다시 내보내는 shim(P2-100에서 삭제).
import { getDialogBridge } from './bridge';

export async function showAlert(message: string): Promise<void> {
  const bridge = getDialogBridge();
  if (bridge?.showAlert) {
    await bridge.showAlert(message);
  } else {
    alert(message);
  }
}

export async function showConfirm(message: string): Promise<boolean> {
  const bridge = getDialogBridge();
  if (bridge?.showConfirm) {
    return await bridge.showConfirm(message);
  }
  return confirm(message);
}
