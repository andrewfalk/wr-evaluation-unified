import { useState, useEffect, useRef } from 'react';
import { DEFAULT_SETTINGS, FONT_SIZE_MAP } from '../utils/data';
import {
  loadAppSettings,
  loadAppSettingsAsync,
  saveAppSettings,
} from '../services/workspaceRepository';

export function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

// 인증 문맥이 바뀌는 설정 변경 — 모드(인트라넷 문맥 여부)나 정규화한 서버 주소.
function authContextChanged(prev, next) {
  return (prev?.integrationMode === 'intranet') !== (next?.integrationMode === 'intranet')
    || normalizeBaseUrl(prev?.apiBaseUrl) !== normalizeBaseUrl(next?.apiBaseUrl);
}

// 설정 라이프사이클(테마/폰트, apiBaseUrl 동기화, Electron 비동기 로드) + 설정 저장/로컬모드 전환
export function useAppSettings({ session, setSession, resetToLocalSession, invalidateAuthContext, discardWorkspace }) {
  const [settings, setSettings] = useState(() => loadAppSettings(DEFAULT_SETTINGS));
  const skipNextSettingsUrlResetRef = useRef(false);
  // 지금 설정(비동기 로드 결과와 비교용 — 마운트 effect의 클로저는 첫 값만 본다).
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // 테마/폰트 적용
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.fontSize = FONT_SIZE_MAP[settings.fontSize] || '16px';
  }, [settings.theme, settings.fontSize]);

  // Sync apiBaseUrl into session when settings change.
  // session.mode is intentionally NOT synced here — it is only set to 'intranet'
  // by login() after server authentication, preventing unauthenticated local
  // sessions from being treated as authenticated by the isAuthenticated gate.
  // If the URL changes while an intranet session is active, the existing auth is
  // invalid for the new server — reset to local so the LoginModal re-prompts.
  useEffect(() => {
    const prev = session;
    const nextBaseUrl = normalizeBaseUrl(settings.apiBaseUrl);
    const prevBaseUrl = normalizeBaseUrl(prev.apiBaseUrl);
    const skipReset = skipNextSettingsUrlResetRef.current;
    skipNextSettingsUrlResetRef.current = false;
    if (prevBaseUrl === nextBaseUrl) return;
    if (skipReset) {
      if (prev.mode !== 'intranet') {
        setSession(s => ({ ...s, apiBaseUrl: nextBaseUrl }));
      }
      return;
    }
    if (prev.mode === 'intranet') {
      resetToLocalSession();
    } else {
      setSession(s => ({ ...s, apiBaseUrl: nextBaseUrl }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.apiBaseUrl]); // intentionally excludes session/setSession/resetToLocalSession — URL-change only

  // Electron: 파일 기반 설정 비동기 로드
  useEffect(() => {
    let cancelled = false;
    loadAppSettingsAsync(DEFAULT_SETTINGS).then(s => {
      if (cancelled) return;
      // 불러온 설정이 모드나 서버 주소를 바꾸면, 그 전에 시작한 로그인 시도를 무효로 한다(사용자 저장과 같은 규칙).
      if (authContextChanged(settingsRef.current, s)) invalidateAuthContext?.();
      skipNextSettingsUrlResetRef.current = true;
      setSettings(s);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps -- mount-only(invalidateAuthContext는 고정 참조)

  const handleSaveSettings = (newSettings) => {
    // 모드나 서버 주소가 바뀌면 진행 중인 로그인 시도·로그아웃을 무효로 한다(작업 공간 주인 유무와 무관) — 늦게 도착한
    // 로그인 응답이 바뀐 문맥에 적용되지 않게.
    if (authContextChanged(settings, newSettings)) invalidateAuthContext?.();
    setSettings(newSettings);
    saveAppSettings(newSettings);
    const nextBaseUrl = normalizeBaseUrl(newSettings.apiBaseUrl);
    const switchingToLocal = newSettings.integrationMode !== 'intranet';
    // Reset intranet session when: switching to local mode, or changing the server URL.
    // Either case means the existing auth token is no longer valid for the new context.
    if (session.mode === 'intranet' && (switchingToLocal || normalizeBaseUrl(session.apiBaseUrl) !== nextBaseUrl)) {
      resetToLocalSession();
    } else {
      setSession(prev => ({ ...prev, apiBaseUrl: nextBaseUrl }));
    }
    // 로컬 문맥이 되거나 서버 주소가 바뀌면, 화면의 목록이 다른 계정의 작업(주인 있음)일 때 화면을 새로 시작한다.
    // 주인이 없으면(로컬 작업) AuthContext가 그대로 둔다.
    if (switchingToLocal || normalizeBaseUrl(settings.apiBaseUrl) !== nextBaseUrl) discardWorkspace?.();
  };

  const switchToLocalMode = () => {
    if (!window.confirm(
      '로컬 모드로 전환하면 서버 동기화가 중단되고 ' +
      '이 브라우저에 저장된 데이터로만 작업하게 됩니다.\n' +
      '서버 감사/동기화에 포함되지 않을 수 있습니다.\n\n계속할까요?'
    )) return;
    handleSaveSettings({ ...settings, integrationMode: 'local' });
  };

  return { settings, setSettings, handleSaveSettings, switchToLocalMode };
}
