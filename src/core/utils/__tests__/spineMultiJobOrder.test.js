import { describe, expect, it } from 'vitest';
import '../../../modules/spine'; // registerModule 사이드이펙트
import { generateEMRFieldData } from '../exportService.js';
import { generateUnifiedReport } from '../reportGenerator.js';

function makeTask(name, sharedJobId) {
  return {
    id: `${name}-${sharedJobId}`,
    name,
    posture: 'G1',
    weight: 15,
    frequency: 80,
    timeValue: 5,
    timeUnit: 'sec',
    correctionFactor: 1.0,
    sharedJobId,
  };
}

function makePatient({ jobs = [], tasks = [] } = {}) {
  return {
    id: 'test-patient',
    data: {
      shared: {
        jobs,
        diagnoses: [],
        patientNo: '', name: 'T', gender: 'male',
        height: '170', weight: '70',
        birthDate: '1980-01-01', injuryDate: '2024-01-01',
        evaluationDate: '2024-12-01',
        hospitalName: '', department: '', doctorName: '',
        specialNotes: '',
        medicalRecord: '',
        highBloodPressure: false, diabetes: false,
        visitHistory: '',
        consultReplyOrtho: '', consultReplyNeuro: '',
        consultReplyRehab: '', consultReplyOther: '',
      },
      modules: { spine: { tasks } },
      activeModules: ['spine'],
    },
  };
}

// 두 라벨 사이 substring 추출
function extractBlock(text, startLabel, endLabels) {
  const start = text.indexOf(startLabel);
  if (start < 0) return '';
  const after = start + startLabel.length;
  let end = text.length;
  for (const label of endLabels) {
    const idx = text.indexOf(label, after);
    if (idx >= 0 && idx < end) end = idx;
  }
  return text.slice(start, end);
}

// 블록 안에서 주어진 순서대로 등장하는지 검증
function assertOrder(block, ordered) {
  let prev = -1;
  for (const needle of ordered) {
    const idx = block.indexOf(needle);
    expect(idx, `${needle} not found in block`).toBeGreaterThanOrEqual(0);
    expect(idx, `${needle} should come after previous`).toBeGreaterThan(prev);
    prev = idx;
  }
}

const J1 = { id: 'j1', jobName: '용접공', workPeriodOverride: '5년 0개월', workDaysPerYear: 250 };
const J2 = { id: 'j2', jobName: '배관공', workPeriodOverride: '3년 0개월', workDaysPerYear: 250 };

const TWO_JOBS = [J1, J2];
const ONE_JOB = [J1];

// 인터리브 케이스: 사용자가 j1을 먼저 채우고 j2를 채운 뒤 j1에 또 추가했다고 가정
const TASKS_INTERLEAVED = [
  makeTask('A1-인양', 'j1'),
  makeTask('B1-배관', 'j2'),
  makeTask('A2-인양', 'j1'),
  makeTask('B2-배관', 'j2'),
  makeTask('A3-인양', 'j1'),
];

// 드래그 결과: j1을 [A1,A2,A3] → [A3,A1,A2]로 재배치한 뒤의 mod.tasks
// handleReorderTask가 visible 슬롯 위치만 보존한 채 새 순서를 채워넣음
const TASKS_AFTER_DRAG = [
  makeTask('A3-인양', 'j1'),
  makeTask('B1-배관', 'j2'),
  makeTask('A1-인양', 'j1'),
  makeTask('B2-배관', 'j2'),
  makeTask('A2-인양', 'j1'),
];

describe('척추 다중 직업 — 출력 순서가 jobResults 기준', () => {
  describe('EMR 직업적 요인 슬롯 (txtJobCusCont)', () => {
    it('인터리브된 mod.tasks에서도 직력1 블록 내부는 mod.tasks 순서대로 A1→A2→A3', () => {
      const patient = makePatient({ jobs: TWO_JOBS, tasks: TASKS_INTERLEAVED });
      const { txtJobCusCont } = generateEMRFieldData(patient);

      const block1 = extractBlock(txtJobCusCont, '[직력1: 용접공]', ['[직력2:', '\n종합']);
      assertOrder(block1, ['A1-인양', 'A2-인양', 'A3-인양']);
      expect(block1).not.toContain('B1-배관');
      expect(block1).not.toContain('B2-배관');

      const block2 = extractBlock(txtJobCusCont, '[직력2: 배관공]', ['\n종합']);
      assertOrder(block2, ['B1-배관', 'B2-배관']);
    });

    it('드래그 후 직력1 블록은 A3→A1→A2 순서', () => {
      const patient = makePatient({ jobs: TWO_JOBS, tasks: TASKS_AFTER_DRAG });
      const { txtJobCusCont } = generateEMRFieldData(patient);

      const block1 = extractBlock(txtJobCusCont, '[직력1: 용접공]', ['[직력2:', '\n종합']);
      assertOrder(block1, ['A3-인양', 'A1-인양', 'A2-인양']);
    });

    it('단일 직업이면 직력 라벨이 등장하지 않음 (평탄 분기)', () => {
      const tasks = [
        makeTask('A1-인양', 'j1'),
        makeTask('A2-인양', 'j1'),
        makeTask('A3-인양', 'j1'),
      ];
      const patient = makePatient({ jobs: ONE_JOB, tasks });
      const { txtJobCusCont } = generateEMRFieldData(patient);

      expect(txtJobCusCont).not.toMatch(/\[직력1:/);
      // 평탄 출력에서도 순서는 보장되어야 함
      const spineStart = txtJobCusCont.indexOf('<허리(요추)>');
      const after = txtJobCusCont.slice(spineStart);
      assertOrder(after, ['A1-인양', 'A2-인양', 'A3-인양']);
    });

    it('빈 직력은 라벨 자체가 등장하지 않음', () => {
      const tasks = [
        makeTask('A1-인양', 'j1'),
        makeTask('A2-인양', 'j1'),
      ];
      const patient = makePatient({ jobs: TWO_JOBS, tasks });
      const { txtJobCusCont } = generateEMRFieldData(patient);

      // jobResults는 길이 2지만 j2 그룹은 비어있으므로 [직력2: 미표시
      expect(txtJobCusCont).not.toMatch(/\[직력2:/);
      // j1 그룹은 표시되어야 함
      expect(txtJobCusCont).toContain('[직력1: 용접공]');
    });
  });

  describe('통합 미리보기 (generateUnifiedReport)', () => {
    it('인터리브된 mod.tasks에서도 직력1 블록 내부는 A1→A2→A3', () => {
      const patient = makePatient({ jobs: TWO_JOBS, tasks: TASKS_INTERLEAVED });
      const text = generateUnifiedReport(patient);

      const block1 = extractBlock(text, '[직력1: 용접공]', ['[직력2:', '\n종합']);
      assertOrder(block1, ['A1-인양', 'A2-인양', 'A3-인양']);
      expect(block1).not.toContain('B1-배관');

      const block2 = extractBlock(text, '[직력2: 배관공]', ['\n종합']);
      assertOrder(block2, ['B1-배관', 'B2-배관']);
    });

    it('드래그 후 직력1 블록은 A3→A1→A2 순서', () => {
      const patient = makePatient({ jobs: TWO_JOBS, tasks: TASKS_AFTER_DRAG });
      const text = generateUnifiedReport(patient);

      const block1 = extractBlock(text, '[직력1: 용접공]', ['[직력2:', '\n종합']);
      assertOrder(block1, ['A3-인양', 'A1-인양', 'A2-인양']);
    });

    it('단일 직업이면 직력 라벨 미등장 (평탄 분기)', () => {
      const tasks = [
        makeTask('A1-인양', 'j1'),
        makeTask('A2-인양', 'j1'),
      ];
      const patient = makePatient({ jobs: ONE_JOB, tasks });
      const text = generateUnifiedReport(patient);

      expect(text).not.toMatch(/\[직력1:/);
    });
  });
});
