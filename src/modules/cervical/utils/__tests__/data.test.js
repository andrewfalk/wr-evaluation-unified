import { describe, expect, it } from 'vitest';
import { syncCervicalModuleData } from '../data';

describe('syncCervicalModuleData', () => {
  it('키 순서만 다른 동일 데이터는 changed=false여야 한다 (JSONB round-trip 등으로 키 순서가 바뀌는 경우)', () => {
    const jobs = [{ id: 'job1' }];
    const task = {
      // createCervicalTask()가 정의하는 순서와 다르게 임의로 섞은 키 순서
      notes: '',
      name: '작업 1',
      sharedJobId: 'job1',
      id: 123,
      exposure_types: [],
      load_weight_kg: '',
      carry_hours_per_shift: '',
      forced_neck_posture: '',
      neck_nonneutral_hours_per_day: '',
      combined_flexion_rotation_posture: '',
      precision_work: '',
    };
    const moduleData = { returnConsiderations: '', tasks: [task] };

    const result = syncCervicalModuleData(moduleData, jobs);

    expect(result.changed).toBe(false);
  });

  it('실제 값이 바뀌면 changed=true여야 한다', () => {
    const jobs = [{ id: 'job1' }];
    const task = { id: 123, sharedJobId: 'job1', name: '작업 1', load_weight_kg: '10' };
    const moduleData = { returnConsiderations: '', tasks: [task] };

    const result = syncCervicalModuleData(moduleData, jobs);
    const resynced = syncCervicalModuleData(result.moduleData, jobs);

    expect(resynced.changed).toBe(false);
  });
});
