// 환경 감지 유틸리티
export const isElectron = () => !!window.electron;

// 크로스 플랫폼 alert
export const showAlert = async (msg) => {
  if (window.electron?.showAlert) {
    await window.electron.showAlert(msg);
  } else {
    alert(msg);
  }
};

// 크로스 플랫폼 confirm
export const showConfirm = async (msg) => {
  if (window.electron?.showConfirm) {
    return await window.electron.showConfirm(msg);
  }
  return confirm(msg);
};
