// @vitest-environment jsdom
// lazyWithReload(REFACTORING_ROADMAP Phase 2 P2-22) — 청크 로드 실패 시 화면 전체가 멈추지 않고 새로고침 안내를 그린다.
import { StrictMode, Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CHUNK_LOAD_FAILED_MESSAGE, lazyWithReload } from '../lazyWithReload';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const renderLazy = (Lazy) => render(
  <StrictMode><Suspense fallback={<p>불러오는 중</p>}><Lazy label="ok" /></Suspense></StrictMode>,
);

describe('lazyWithReload', () => {
  it('성공하면 그 컴포넌트를 그대로 렌더한다(props 전달)', async () => {
    const Lazy = lazyWithReload(async () => ({ default: ({ label }) => <p>화면 {label}</p> }));
    renderLazy(Lazy);
    expect(await screen.findByText('화면 ok')).toBeTruthy();
  });

  it('청크 로드가 실패하면(배포 뒤 옛 해시 청크 등) 던지지 않고 새로고침 안내를 렌더한다', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const Lazy = lazyWithReload(() => Promise.reject(new TypeError('Failed to fetch dynamically imported module')));
    renderLazy(Lazy);
    const dialog = await screen.findByRole('alertdialog', { name: '화면을 불러오지 못함' });
    expect(dialog.textContent).toContain(CHUNK_LOAD_FAILED_MESSAGE);
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    fireEvent.click(screen.getByRole('button', { name: '새로고침' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
