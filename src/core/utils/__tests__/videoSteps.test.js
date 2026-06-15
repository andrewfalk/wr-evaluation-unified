import { describe, it, expect, vi } from 'vitest';

// buildSteps는 getModule로 모듈 탭을 만든다 — 테스트에선 가벼운 가짜 모듈로 대체.
vi.mock('../../moduleRegistry', () => ({
  getModule: (id) => ({ id, name: id, icon: 'x', tabs: [{ id: 'job', label: 'Job' }] }),
}));

import { buildSteps } from '../steps.js';

describe('buildSteps — videoAnalysis feature flag', () => {
  it('omits the videoAnalysis step when flag is off (default)', () => {
    const ids = buildSteps([]).map((s) => s.id);
    expect(ids).not.toContain('videoAnalysis');
    expect(ids).toEqual(['info', 'diagnosis', 'modules']);
  });

  it('omits the videoAnalysis step when explicitly disabled', () => {
    const ids = buildSteps(['knee'], { videoAnalysisEnabled: false }).map((s) => s.id);
    expect(ids).not.toContain('videoAnalysis');
  });

  it('inserts videoAnalysis (shared group) right after modules when enabled', () => {
    const steps = buildSteps([], { videoAnalysisEnabled: true });
    const ids = steps.map((s) => s.id);
    expect(ids).toEqual(['info', 'diagnosis', 'modules', 'videoAnalysis']);
    const va = steps.find((s) => s.id === 'videoAnalysis');
    expect(va.group).toBe('shared');
  });

  it('keeps videoAnalysis before module tabs; firstModule index still finds a module tab', () => {
    const steps = buildSteps(['knee'], { videoAnalysisEnabled: true });
    const ids = steps.map((s) => s.id);
    const vaIdx = ids.indexOf('videoAnalysis');
    const firstModuleIdx = steps.findIndex((s) => s.group !== 'shared');
    expect(vaIdx).toBeGreaterThan(ids.indexOf('modules'));
    expect(firstModuleIdx).toBeGreaterThan(vaIdx); // 모듈 탭은 videoAnalysis 뒤
    expect(steps[firstModuleIdx].moduleId).toBe('knee');
  });
});
