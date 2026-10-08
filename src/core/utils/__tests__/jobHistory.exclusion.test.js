import { describe, expect, it, vi } from 'vitest';

// html2pdf.js UMD는 브라우저 전역 `self`를 참조하므로 모듈 index.js(→ exportHandlers) import 시 node 환경에서
// ReferenceError가 난다. PDF 생성은 이 테스트와 무관하므로 모킹한다(batchImportConfig.test.js와 동일).
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/spine';
import '../../../modules/cervical';
import '../../../modules/elbow';
import '../../../modules/wrist';
import { buildJobHistoryLines, resolveJobNumber, EXCLUDED_JOB_LABEL, NO_EVALUABLE_JOBS_NOTE } from '../jobHistory.js';
import { generateUnifiedEMR, generateEMRFieldData } from '../emrReport.js';
import { generateUnifiedReport } from '../reportGenerator.js';

const job = (id, jobName, extra = {}) => ({
  id, jobName, startDate: '2010-01-01', endDate: '2015-01-01', workPeriodOverride: '', workDaysPerYear: 250, ...extra,
});
const excl = (j) => ({ ...j, excludeFromAnalysis: true });

function makePatient({ jobs = [], activeModules = [], modules = {}, diagnoses = [] } = {}) {
  return {
    id: 'p1',
    data: {
      shared: {
        name: '', gender: '', height: '', weight: '', birthDate: '1970-01-01', injuryDate: '2020-01-01',
        specialNotes: '', jobs, diagnoses,
        hospitalName: '', department: '', doctorName: '', evaluationDate: '',
      },
      modules,
      activeModules,
    },
  };
}

describe('buildJobHistoryLines', () => {
  it('미포함 직력이 없으면 종전 포맷 그대로이고 번호 맵은 null', () => {
    const { lines, text, numberingByJobId } = buildJobHistoryLines([job('a', '용접공'), job('b', '')]);
    expect(lines).toEqual([
      '- 직력1: 용접공 | 2010-01-01 ~ 2015-01-01 (5년 0개월)',
      '- 직력2: - | 2010-01-01 ~ 2015-01-01 (5년 0개월)',
    ]);
    expect(text).toBe(`${lines[0]}\n${lines[1]}\n`);
    expect(numberingByJobId).toBeNull();
  });

  it('미포함 직력은 가장 끝에 "신체부담평가에는 미포함" 표기와 함께 나오고 포함 직력이 직력1..k가 된다', () => {
    const { lines, numberingByJobId } = buildJobHistoryLines([excl(job('a', '사무직')), job('b', '철근공'), job('c', '용접공')]);
    expect(lines[0]).toMatch(/^- 직력1: 철근공 \|/);
    expect(lines[1]).toMatch(/^- 직력2: 용접공 \|/);
    expect(lines[2]).toMatch(/^- 직력3: 사무직 \| .* \| 신체부담평가에는 미포함$/);
    expect(lines[0]).not.toContain(EXCLUDED_JOB_LABEL);
    expect(numberingByJobId).toEqual({ b: 1, c: 2, a: 3 });
  });

  it('입력 배열을 변경하지 않고, 배열이 아니면 빈 결과', () => {
    const jobs = [excl(job('a', 'A')), job('b', 'B')];
    const before = jobs.slice();
    buildJobHistoryLines(jobs);
    expect(jobs).toEqual(before);
    expect(buildJobHistoryLines(undefined).lines).toEqual([]);
  });

  it('resolveJobNumber는 맵이 있고 id가 있으면 맵 번호, 아니면 fallback', () => {
    expect(resolveJobNumber({ x: 3 }, 'x', 1)).toBe(3);
    expect(resolveJobNumber({ x: 3 }, 'y', 1)).toBe(1);
    expect(resolveJobNumber(null, 'x', 1)).toBe(1);
  });
});

describe('직업력 출력 — EMR/엑셀/종합소견 미리보기에 모두 남고 미포함은 끝에 표기', () => {
  const patient = makePatient({
    jobs: [job('a', '철근공'), excl(job('b', '사무직')), job('c', '용접공')],
    activeModules: ['knee'],
    modules: { knee: { jobExtras: [{ sharedJobId: 'a', weight: '5000', squatting: '200' }, { sharedJobId: 'c', weight: '1000', squatting: '10' }] } },
  });

  it('txtJobCusCont(= 엑셀 4.직업적 요인)의 [직업력]', () => {
    const { txtJobCusCont } = generateEMRFieldData(patient);
    const section = txtJobCusCont.split('[부위별 신체부담 평가]')[0];
    expect(section).toContain('- 직력1: 철근공');
    expect(section).toContain('- 직력2: 용접공');
    expect(section).toMatch(/- 직력3: 사무직 \| .* \| 신체부담평가에는 미포함/);
  });

  it('b8(= 종합소견 미리보기·txtSyth1Cont)의 [직업력]도 같은 순서·표기', () => {
    const { b8 } = generateUnifiedEMR(patient);
    expect(b8.indexOf('직력1: 철근공')).toBeLessThan(b8.indexOf('직력2: 용접공'));
    expect(b8.indexOf('직력2: 용접공')).toBeLessThan(b8.indexOf('직력3: 사무직'));
    expect(b8).toContain('신체부담평가에는 미포함');
  });

  it('통합 텍스트 리포트의 [직업력]도 같다', () => {
    const report = generateUnifiedReport(patient);
    expect(report).toMatch(/- 직력3: 사무직 \| .* \| 신체부담평가에는 미포함/);
  });

  it('무릎 신체부담 블록에는 미포함 직력(사무직)이 나오지 않는다', () => {
    const { txtJobCusCont } = generateEMRFieldData(patient);
    const burden = txtJobCusCont.split('<무릎(슬관절)>')[1];
    expect(burden).toContain('직종: 철근공');
    expect(burden).toContain('직종: 용접공');
    expect(burden).not.toContain('사무직');
  });

  it('미포함이 없으면 [직업력]에 표기가 전혀 없다 (종전 출력)', () => {
    const clean = makePatient({ jobs: [job('a', '철근공'), job('c', '용접공')] });
    expect(generateEMRFieldData(clean).txtJobCusCont).not.toContain('미포함');
  });
});

describe('전부 미포함 — 모듈 블록은 임상 결론 대신 평가 대상 없음 한 줄', () => {
  const allExcluded = (activeModules, modules) => makePatient({
    jobs: [excl(job('a', '사무직')), excl(job('b', '관리직'))],
    activeModules,
    modules,
  });
  const MODULES = {
    knee: { jobExtras: [{ sharedJobId: 'a', weight: '5000', squatting: '200' }] },
    shoulder: { jobExtras: [{ sharedJobId: 'a', overheadHours: '4' }] },
    elbow: {},
    wrist: {},
    cervical: { tasks: [] },
    spine: { mddmStatus: 'present', tasks: [] },
  };

  it.each(['knee', 'shoulder', 'elbow', 'wrist', 'cervical', 'spine'])('%s: txtJobCusCont와 b8, 통합 리포트 모두', (moduleId) => {
    const patient = allExcluded([moduleId], { [moduleId]: MODULES[moduleId] });
    const field = generateEMRFieldData(patient);
    expect(field.txtJobCusCont).toContain(NO_EVALUABLE_JOBS_NOTE);
    expect(field.txtSyth1Cont).toContain(NO_EVALUABLE_JOBS_NOTE);
    expect(generateUnifiedReport(patient)).toContain(NO_EVALUABLE_JOBS_NOTE);
  });

  it('어깨: "누적 신체부담 불충분" 같은 임상 결론을 만들지 않는다', () => {
    const patient = allExcluded(['shoulder'], { shoulder: MODULES.shoulder });
    const field = generateEMRFieldData(patient);
    for (const text of [field.txtJobCusCont, field.txtSyth1Cont, generateUnifiedReport(patient)]) {
      expect(text).not.toContain('불충분');
      expect(text).not.toContain('충분함');
    }
  });

  it('직업력은 그대로 출력된다 (전부 미포함 표기)', () => {
    const patient = allExcluded(['knee'], { knee: MODULES.knee });
    const { txtJobCusCont } = generateEMRFieldData(patient);
    expect((txtJobCusCont.match(/신체부담평가에는 미포함/g) || []).length).toBe(2);
  });
});

describe('어깨 보고서 [직력별 기여] 번호 — 직업력 번호와 일치', () => {
  const extras = [
    { sharedJobId: 'e', overheadHours: '1' },
    { sharedJobId: 'p', overheadHours: '2' },
    { sharedJobId: 'w', overheadHours: '3' },
    { sharedJobId: 'o', overheadHours: '9' },
  ];

  it('직종명이 빈 포함 직력이 있고 미포함 직력이 있으면: 생산직=직력2, 용접공=직력3 (직업력 목록과 동일)', () => {
    const patient = makePatient({
      jobs: [excl(job('o', '사무직')), job('e', ''), job('p', '생산직'), job('w', '용접공')],
      activeModules: ['shoulder'],
      modules: { shoulder: { jobExtras: extras } },
    });
    const report = generateUnifiedReport(patient);
    const history = report.split('[직업력]')[1].split('[부위별 신체부담 평가]')[0];
    expect(history).toContain('- 직력2: 생산직');
    expect(history).toContain('- 직력3: 용접공');
    const contribution = report.split('[직력별 기여]')[1];
    expect(contribution).toContain('- 직력2: 생산직');
    expect(contribution).toContain('- 직력3: 용접공');
    expect(contribution).not.toContain('사무직');
  });

  it('미포함 직력이 없으면 기존 규칙(직종명 있는 직력끼리 1부터 재번호)을 그대로 쓴다', () => {
    const patient = makePatient({
      jobs: [job('e', ''), job('p', '생산직'), job('w', '용접공')],
      activeModules: ['shoulder'],
      modules: { shoulder: { jobExtras: extras } },
    });
    const contribution = generateUnifiedReport(patient).split('[직력별 기여]')[1];
    expect(contribution).toContain('- 직력1: 생산직');
    expect(contribution).toContain('- 직력2: 용접공');
  });
});
