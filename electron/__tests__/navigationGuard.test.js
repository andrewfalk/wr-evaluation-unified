import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isAllowedStandaloneNavigation } from '../navigationGuard.js';

// 운영: file:// 로 앱 디렉터리를 연다. 경로는 플랫폼에 맞게 만든다.
const APP_DIR = path.resolve('fixture-app', 'dist', 'electron');
const fileUrl = (...parts) => pathToFileURL(path.join(APP_DIR, ...parts)).href;
const prod = (url) => isAllowedStandaloneNavigation(url, { isDev: false, appDir: APP_DIR });
const dev = (url) => isAllowedStandaloneNavigation(url, { isDev: true, appDir: APP_DIR });

describe('isAllowedStandaloneNavigation — 운영(file://)', () => {
  it('앱 디렉터리 안의 파일(index.html·해시/쿼리 포함)은 허용', () => {
    expect(prod(fileUrl('index.html'))).toBe(true);
    expect(prod(`${fileUrl('index.html')}#/patients?x=1`)).toBe(true);
    expect(prod(fileUrl('assets', 'app.js'))).toBe(true);
  });

  it('앱 디렉터리 밖의 file:// 은 차단', () => {
    expect(prod(pathToFileURL(path.resolve('somewhere-else', 'secret.html')).href)).toBe(false);
  });

  it('경로 이탈(..)을 정규화한 뒤 판정한다', () => {
    const escaped = `${pathToFileURL(APP_DIR).href}/../../outside.html`;
    expect(prod(escaped)).toBe(false);
  });

  it('접두사만 같은 형제 디렉터리는 차단 — dist/electron-evil', () => {
    expect(prod(pathToFileURL(path.join(`${APP_DIR}-evil`, 'index.html')).href)).toBe(false);
  });

  it('외부 http(s)·data·javascript·UNC 호스트가 있는 file:// 는 차단', () => {
    for (const url of ['https://evil.example/', 'http://localhost:3000/', 'data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'file://evil-host/share/index.html']) {
      expect(prod(url), url).toBe(false);
    }
  });

  it('잘못된 URL은 던지지 않고 차단', () => {
    for (const url of ['', 'not a url', undefined, null]) expect(prod(url), String(url)).toBe(false);
  });

  it('blob: 객체 URL은 허용 — Excel·PDF 내보내기가 스스로 만든 데이터라 외부 콘텐츠를 가리킬 수 없다', () => {
    expect(prod('blob:null/3f2c1a9e-0000-4000-8000-000000000000')).toBe(true);
  });

  it('Windows에서는 경로 대소문자를 구분하지 않는다', () => {
    if (process.platform !== 'win32') return;
    expect(prod(fileUrl('index.html').toUpperCase().replace('FILE:', 'file:'))).toBe(true);
  });
});

describe('isAllowedStandaloneNavigation — 개발(localhost:3000)', () => {
  it('개발 서버 origin만 허용', () => {
    expect(dev('http://localhost:3000/')).toBe(true);
    expect(dev('http://localhost:3000/patients?x=1')).toBe(true);
  });

  it('다른 포트·호스트·접미사 속임수·file://·외부는 차단', () => {
    for (const url of ['http://localhost:3001/', 'http://127.0.0.1:3000/', 'http://localhost:3000.evil.com/', 'https://localhost:3000/', fileUrl('index.html')]) {
      expect(dev(url), url).toBe(false);
    }
  });
});
