// 전이 = 옮기기 전 익명 updater(REFACTORING_ROADMAP Phase 2 P2-36: useEMRIntegration #20·21, usePresetManagement #23,
// useIntakeWizard #22). 옛 구현을 이 파일에 옮겨 적고 같은 입력에 같은 출력(값·참조)을 내는지 비교한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { touchPatientRecord } from '../../../services/patientRecords';
import { getModule, registerModule } from '../../../moduleRegistry';
import { patientTx } from '../transitions';

const NOW = new Date('2026-11-14T05:06:07.000Z');
const SESSION = { mode: 'intranet', user: { id: 'u1', organizationId: 'org1' } };

registerModule({
  id: 'p236-a',
  createModuleData: () => ({ base: true }),
  presetConfig: { applyToModule: (moduleData, jobId, presetData) => ({ ...moduleData, [`job-${jobId}`]: presetData }) },
});
registerModule({ id: 'p236-b', createModuleData: () => ({ b: 0 }) }); // 프리셋 미지원

// --- 옛 구현(main) ---
const oldEmrShared = (targetId, updated, session) => prev => prev.map(pt =>
  pt.id === targetId
    ? touchPatientRecord({ ...pt, updatedAt: new Date().toISOString(), data: { ...pt.data, shared: updated } }, { session })
    : pt
);
const oldPreset = (activeId, canMutateActivePatient, preset, jobId, session) => prev => prev.map(p => {
  if (p.id !== activeId || !canMutateActivePatient) return p;
  const newModules = { ...p.data.modules };
  for (const moduleId of (p.data.activeModules || [])) {
    const mod = getModule(moduleId);
    const presetModuleData = preset.modules?.[moduleId];
    if (mod?.presetConfig?.applyToModule && presetModuleData) {
      newModules[moduleId] = mod.presetConfig.applyToModule(newModules[moduleId] || mod.createModuleData(), jobId, presetModuleData);
    }
  }
  return touchPatientRecord({ ...p, data: { ...p.data, modules: newModules } }, { session });
});
const oldWizard = p => prev => [...prev, p];

function list() {
  return [
    { id: 'x', data: { shared: { name: 'X', diagnoses: [{ code: 'M1' }] }, modules: { 'p236-a': { kept: 1 } }, activeModules: ['p236-a', 'p236-b'] }, sync: { serverId: 's-x', revision: 2, syncStatus: 'synced' }, meta: { createdBy: 'u1' } },
    { id: 'y', data: { shared: { name: 'Y' }, modules: {}, activeModules: ['p236-a'] }, sync: { syncStatus: 'local-only' } },
    { id: 'r', redacted: true, data: { shared: { name: 'R' }, modules: {}, activeModules: [] }, sync: { serverId: 's-r', revision: 1, syncStatus: 'synced' } },
  ];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});
afterEach(() => { vi.useRealTimers(); });

describe('patient/sharedReplaced = 옛 EMR 추출·다학제 회신 updater(#20·#21, 현행 그대로)', () => {
  const updated = { name: '추출 이름', birthDate: '1970-01-01', diagnoses: [{ code: 'M1' }, { id: 'n', code: 'M2', name: 'new', side: '' }] };
  for (const id of ['x', 'y', 'r', 'missing']) {
    it(id, () => {
      const prev = list();
      const actual = patientTx.sharedReplaced({ id, shared: updated, session: SESSION })(prev);
      expect(actual).toEqual(oldEmrShared(id, updated, SESSION)(list()));
      expect(actual).not.toBe(prev);
      prev.forEach((p, i) => { if (p.id !== id) expect(actual[i]).toBe(p); });
    });
  }
});

describe('patient/dataEdited(프리셋) = 옛 applyPreset updater(#23)', () => {
  const preset = { jobName: 'J', modules: { 'p236-a': { v: 1 }, 'p236-b': { v: 2 } } };
  for (const activeId of ['x', 'y', 'missing', null]) {
    for (const canMutate of [true, false]) {
      it(`active=${activeId} · canMutate=${canMutate}`, () => {
        const prev = list();
        const edit = data => {
          const newModules = { ...data.modules };
          for (const moduleId of (data.activeModules || [])) {
            const mod = getModule(moduleId);
            const presetModuleData = preset.modules?.[moduleId];
            if (mod?.presetConfig?.applyToModule && presetModuleData) {
              newModules[moduleId] = mod.presetConfig.applyToModule(newModules[moduleId] || mod.createModuleData(), 'job1', presetModuleData);
            }
          }
          return { ...data, modules: newModules };
        };
        const actual = patientTx.dataEdited({ id: canMutate ? activeId : null, edit, session: SESSION })(prev);
        expect(actual).toEqual(oldPreset(activeId, canMutate, preset, 'job1', SESSION)(list()));
        expect(actual).not.toBe(prev);
        prev.forEach((p, i) => { if (!(canMutate && p.id === activeId)) expect(actual[i]).toBe(p); });
      });
    }
  }
});

describe('patients/appended(위자드) = 옛 위자드 완료 updater(#22)', () => {
  it('1명 덧붙인 새 배열', () => {
    const prev = list();
    const p = { id: 'new', data: { shared: {}, modules: {}, activeModules: [] } };
    const actual = patientTx.appended({ patients: [p] })(prev);
    expect(actual).toEqual(oldWizard(p)(list()));
    expect(actual[3]).toBe(p);
    expect(actual[0]).toBe(prev[0]);
  });
});
