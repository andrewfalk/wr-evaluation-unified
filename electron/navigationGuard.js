'use strict';
// electron/navigationGuard.js — HF9
// 독립형 빌드에서 메인 창이 이동·리다이렉트할 수 있는 곳을 자기 앱으로만 제한한다(인트라넷 빌드는 main.js가
// 허용 origin으로 이미 제한). electron에 의존하지 않는 순수 함수라 테스트한다.
const path = require('path');
const { fileURLToPath } = require('url');

const DEV_ORIGIN = 'http://localhost:3000';

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * @param {string}  url
 * @param {object}  opts
 * @param {boolean} opts.isDev   개발 서버(http://localhost:3000)를 로드하는 중인가
 * @param {string}  opts.appDir  설치된 앱의 렌더러 디렉터리(dist/electron)
 */
function isAllowedStandaloneNavigation(url, { isDev, appDir }) {
  let u;
  try { u = new URL(url); } catch { return false; }

  // Excel·PDF 내보내기가 만드는 객체 URL — 이 문서가 스스로 만든 데이터라 외부 콘텐츠를 가리킬 수 없다.
  if (u.protocol === 'blob:') return true;

  if (isDev) return u.origin === DEV_ORIGIN;

  if (u.protocol !== 'file:') return false;
  let filePath;
  try { filePath = path.resolve(fileURLToPath(u)); } catch { return false; } // UNC·잘못된 경로
  const root = path.resolve(appDir) + path.sep;
  return norm(filePath).startsWith(norm(root));
}

module.exports = { isAllowedStandaloneNavigation };
