// 설정 창 조각(P2-86c, Phase 2 C9 구간 A) — SettingsModal.tsx에서 옮겼다. 서버 주소·연결 상태의 순수 함수(본문 그대로 — 예전 지역 normalizeUrl은
// 본문이 같은 platform/dataMode의 normalizeBaseUrl로 바꿔 쓴다).
import { isIntranetContext, normalizeBaseUrl } from '../../../platform/dataMode';
import type { DiagnosticStatus, SettingsDraft, SettingsSession } from './types';

// 기본 인트라넷 주소 — Electron 셸(electron/main.js·preload-intranet.js)의 기본 주소와 같은 값이어야 한다(P2-87, 일치 테스트: settings/__tests__/defaultIntranetUrl.consistency.test.ts).
export const DEFAULT_INTRANET_URL = 'https://wr.hospital.local:8443';

export function getEffectiveServerUrl({ session, diagnostic, draft }: { session?: SettingsSession | null; diagnostic?: DiagnosticStatus | null; draft?: SettingsDraft } = {}) {
  return normalizeBaseUrl(
    session?.apiBaseUrl ||
    diagnostic?.baseUrl ||
    draft?.apiBaseUrl ||
    (isIntranetContext({ session, settings: draft }) ? DEFAULT_INTRANET_URL : '')
  );
}

export function buildPreviewSession(session: SettingsSession | null | undefined, draft: SettingsDraft) {
  const draftUrl = normalizeBaseUrl(draft.apiBaseUrl || '');
  return {
    ...session,
    mode: isIntranetContext({ settings: draft }) ? 'intranet' : 'local',
    apiBaseUrl: draftUrl || (
      isIntranetContext({ session, settings: draft })
        ? DEFAULT_INTRANET_URL
        : ''
    ),
  };
}

export function formatCheckedAt(value: string | null | undefined) {
  if (!value) return '-';

  try {
    return new Date(value).toLocaleString('ko-KR');
  } catch {
    return value;
  }
}

export function formatBoolean(value: boolean | null | undefined) {
  if (value === true) return '있음';
  if (value === false) return '없음';
  return '-';
}

export function getStatusTitle(status: DiagnosticStatus | null | undefined) {
  if (status?.connectivity === 'fallback') return '로컬 폴백';
  if (status?.connectivity === 'connected' && status?.mock) return 'Mock 인트라넷 연결됨';
  if (status?.connectivity === 'connected') return '인트라넷 연결됨';
  if (status?.connectivity === 'checking') return '서버 확인 중';
  return '로컬 저장소';
}

export function getStatusTone(status: DiagnosticStatus | null | undefined) {
  if (status?.connectivity === 'fallback') return 'fallback';
  if (status?.connectivity === 'connected' && status?.mock) return 'mock';
  if (status?.connectivity === 'connected') return 'connected';
  if (status?.connectivity === 'checking') return 'checking';
  return 'local';
}
