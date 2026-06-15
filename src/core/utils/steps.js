import { getModule } from '../moduleRegistry';

export function buildSteps(activeModules, options = {}) {
  const { videoAnalysisEnabled = false } = options;
  const steps = [
    { id: 'info', label: '기본정보', group: 'shared' },
    { id: 'diagnosis', label: '상병 입력', group: 'shared' },
    { id: 'modules', label: '모듈 선택', group: 'shared' },
  ];
  // 영상 분석 공유 스텝(v6.0.0) — 피처플래그 on일 때만. 모듈 탭 앞(모듈 선택 직후).
  if (videoAnalysisEnabled) {
    steps.push({ id: 'videoAnalysis', label: '[공유] 영상 분석', group: 'shared' });
  }
  for (const moduleId of activeModules) {
    const mod = getModule(moduleId);
    if (!mod) continue;
    for (const tab of mod.tabs) {
      steps.push({
        id: `${moduleId}:${tab.id}`,
        label: tab.label,
        group: moduleId,
        moduleId,
        tabId: tab.id,
        icon: mod.icon,
        moduleName: mod.name,
      });
    }
  }
  if (activeModules.length > 0) {
    steps.push({ id: 'assessment', label: '종합소견', group: 'shared' });
    steps.push({ id: 'ai', label: 'AI 분석', group: 'shared' });
  }
  return steps;
}
