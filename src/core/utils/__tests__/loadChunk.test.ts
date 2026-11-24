// 늦게 내려받는 코드 조각의 로드 실패 안내(FX-5).
import { describe, expect, it, vi } from 'vitest';
import { CHUNK_LOAD_FAILED_MESSAGE } from '../../components/lazyWithReload';
import { ChunkLoadError, loadChunk } from '../loadChunk';

describe('loadChunk', () => {
  it('import가 되면 모듈을 그대로 돌려준다', async () => {
    await expect(loadChunk(async () => ({ value: 1 }))).resolves.toEqual({ value: 1 });
  });

  it('import가 실패하면 한국어 안내 문구의 ChunkLoadError(원래 오류는 cause)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const original = new TypeError('Failed to fetch dynamically imported module: /assets/old.js');
    const error = await loadChunk(() => Promise.reject(original)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChunkLoadError);
    expect((error as ChunkLoadError).message).toBe(CHUNK_LOAD_FAILED_MESSAGE);
    expect((error as ChunkLoadError).cause).toBe(original);
  });
});
