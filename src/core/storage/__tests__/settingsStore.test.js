// @vitest-environment jsdom
// settingsStore(REFACTORING_ROADMAP Phase 2 P2-18) — 설정 읽기/쓰기 한 곳.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStoredSettings, writeStoredSettings } from '../settingsStore';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('settingsStore', () => {
  it('없으면 null, 저장하면 같은 객체, 깨진 JSON·객체 아닌 값은 null(지우지 않음)', () => {
    expect(readStoredSettings()).toBeNull();
    writeStoredSettings({ theme: 'dark', geminiApiKey: 'k' });
    expect(localStorage.getItem('wrEvalUnifiedSettings')).toBe('{"theme":"dark","geminiApiKey":"k"}');
    expect(readStoredSettings()).toEqual({ theme: 'dark', geminiApiKey: 'k' });
    localStorage.setItem('wrEvalUnifiedSettings', '{bad');
    expect(readStoredSettings()).toBeNull();
    expect(localStorage.getItem('wrEvalUnifiedSettings')).toBe('{bad');
    localStorage.setItem('wrEvalUnifiedSettings', '5');
    expect(readStoredSettings()).toBeNull();
  });

  it('저장소 접근이 던지면 읽기는 null', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    expect(readStoredSettings()).toBeNull();
  });

  it('용량 초과는 사용자 문구로, 그 밖의 오류는 그대로', () => {
    const quota = Object.assign(new Error('quota'), { name: 'QuotaExceededError' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw quota; });
    expect(() => writeStoredSettings({})).toThrow('저장 공간이 부족합니다. 기존 저장 데이터를 삭제해주세요.');
    const other = new Error('other');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw other; });
    expect(() => writeStoredSettings({})).toThrow(other);
  });
});
