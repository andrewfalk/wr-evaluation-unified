// 설정 저장소(브라우저 쪽) — REFACTORING_ROADMAP Phase 2 C2(P2-18). 설정(독립형 AI API 키 포함)을 localStorage에서
// 읽고 쓰는 곳은 여기 하나다(예전 storage.js와 analysisClient.js가 같은 키를 따로 선언하고 각자 읽었다).
// Phase 3 M5(독립형 API 키 safeStorage)는 이 파일과 platform의 getFsBridge()만 바꾸면 된다.
import { STORAGE_KEYS } from './keys';

export type StoredSettings = Record<string, unknown>;

/**
 * 저장된 설정 원본. 없거나 깨졌거나 저장소를 쓸 수 없으면 null.
 * (깨진 값을 지우지 않는다 — 예전 loadSettings·loadAISettings 모두 그대로 뒀다.)
 */
export function readStoredSettings(): StoredSettings | null {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEYS.settings);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as StoredSettings) : null;
  } catch {
    return null;
  }
}

/** 설정 저장. 용량 초과는 사용자 문구로 바꿔 던진다(예전 storage.js safeSetItem과 같음). */
export function writeStoredSettings(settings: StoredSettings): void {
  try {
    localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'QuotaExceededError') {
      throw new Error('저장 공간이 부족합니다. 기존 저장 데이터를 삭제해주세요.');
    }
    throw e;
  }
}
