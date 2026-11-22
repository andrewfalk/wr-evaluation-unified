// 운영 모듈 등록(src/modules/index.ts) — P2-49(Phase 2 C5).
// ① 6모듈 매니페스트는 검사 문제가 0건이다(등록 중 경고 0). ② getAllModules() 순서 = 옛 App.jsx 등록 순서.
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('src/modules/index.ts', () => {
  it('6모듈을 옛 App 순서로 등록하고, 등록 중 매니페스트 경고가 없다', async () => {
    const warn = vi.spyOn(console, 'warn');
    await import('../index');
    const { getAllModules } = await import('../../core/moduleRegistry');
    const { validateManifest } = await import('../../core/modules/manifest');

    expect(warn).not.toHaveBeenCalled();
    const modules: unknown[] = getAllModules();
    expect(modules.map(mod => (mod as { id: string }).id)).toEqual(['knee', 'spine', 'cervical', 'shoulder', 'elbow', 'wrist']);
    for (const mod of modules) {
      expect(validateManifest(mod), (mod as { id: string }).id).toEqual([]);
    }
  });
});
