// 서술 모듈 블록 조립(P2-66a) — 소견서와 EMR b6·b8이 같은 함수(renderNarrativeBlocks)로 모듈 블록을 activeModules 순서로
// 만든다(ADR 0001 B1). 그리고 "소견서 ≡ EMR 4번 칸" 검사: 골든·보강 환자 전원에 대해 모듈 서술의 render('report')와
// render('emrSection')이 같다 — 게이트 C에서 맞춘 모듈을 여기에 더한다(손목·팔꿈치는 narrativeEmpty 줄만 예외).
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../modules';
import { loadGoldenBatchPatients, loadGoldenNarrativePatients, loadGoldenPatients } from '../../fixtures/goldenPatients';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { buildJobHistoryLines } from '../../utils/jobHistory';
import { getModule } from '../../modules/registry';
import { renderNarrativeBlocks } from '../renderBlocks';

interface GoldenPatient {
  id: string;
  data: { shared: Record<string, unknown>; modules: Record<string, unknown>; activeModules?: string[] };
}

const allPatients = (): GoldenPatient[] => [
  ...loadGoldenPatients(),
  ...loadGoldenBatchPatients(),
  ...loadGoldenNarrativePatients(),
] as GoldenPatient[];

function moduleOf(id: string) {
  const manifest = getModule(id);
  if (!manifest?.narrative) throw new Error(`서술 모듈 '${id}'가 등록되지 않았다`);
  return { manifest, narrative: manifest.narrative };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('renderNarrativeBlocks', () => {
  it('activeModules 순서로 블록을 낸다 — 등록 순서와 무관', () => {
    const patient = loadGoldenNarrativePatients().find((p: GoldenPatient) => p.id === 'golden-narr-all-modules') as GoldenPatient;
    const { shared, modules } = patient.data;
    const forward = ['wrist', 'knee'];
    const text = renderNarrativeBlocks('emrSection', shared, modules, forward, {});
    const parts = forward.map(id => {
      const { manifest, narrative } = moduleOf(id);
      return narrative.render('emrSection', manifest.computeCalc({ shared, module: modules[id] || {} }), {});
    });
    expect(text).toBe(parts.join(''));
    expect(renderNarrativeBlocks('emrSection', shared, modules, ['knee', 'wrist'], {})).toBe(`${parts[1]}${parts[0]}`);
  });

  it('등록되지 않은 id는 건너뛰고, 같은 id가 두 번이면 두 번 낸다', () => {
    const patient = loadGoldenNarrativePatients().find((p: GoldenPatient) => p.id === 'golden-narr-all-modules') as GoldenPatient;
    const { shared, modules } = patient.data;
    const knee = renderNarrativeBlocks('report', shared, modules, ['knee'], {});
    expect(knee.length).toBeGreaterThan(0);
    expect(renderNarrativeBlocks('report', shared, modules, ['no-such-module', 'knee'], {})).toBe(knee);
    expect(renderNarrativeBlocks('report', shared, modules, ['knee', 'knee'], {})).toBe(`${knee}${knee}`);
    expect(renderNarrativeBlocks('report', shared, modules, [], {})).toBe('');
  });

  it('context(직업력 번호 맵)를 모듈 서술에 그대로 넘기고, 모듈 데이터가 없으면 빈 객체로 계산한다', () => {
    const { manifest, narrative } = moduleOf('shoulder');
    const render = vi.spyOn(narrative, 'render');
    const calc = vi.spyOn(manifest, 'computeCalc');
    const context = { jobNumberingByJobId: { j1: 2 } };
    const shared = { jobs: [] };
    renderNarrativeBlocks('emrSection', shared, {}, ['shoulder'], context);
    expect(calc).toHaveBeenCalledWith({ shared, module: {} });
    expect(render).toHaveBeenCalledWith('emrSection', calc.mock.results[0].value, context);
  });
});

// 게이트 C에서 소견서와 4번 칸을 맞춘 모듈. 맞춘 PR이 여기에 더한다.
const REPORT_EQUALS_EMR_SECTION = ['spine', 'knee', 'shoulder', 'cervical'];

describe('소견서 ≡ EMR 4번 칸(모듈 서술)', () => {
  it.each(REPORT_EQUALS_EMR_SECTION)('%s: 골든·보강 환자 전원에서 render("report") === render("emrSection")', (moduleId) => {
    useGoldenEnvironment();
    const { manifest, narrative } = moduleOf(moduleId);
    let checked = 0;
    for (const patient of allPatients()) {
      if (!(patient.data.activeModules || []).includes(moduleId)) continue;
      const calc = manifest.computeCalc({ shared: patient.data.shared, module: patient.data.modules[moduleId] || {} });
      const context = { jobNumberingByJobId: buildJobHistoryLines(patient.data.shared.jobs as unknown[]).numberingByJobId };
      expect(narrative.render('report', calc, context), patient.id).toBe(narrative.render('emrSection', calc, context));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// 손목·팔꿈치(P2-66d): 분석 정리가 빈 값일 때의 줄(narrativeEmpty — ADR 0001 표 A 13·19행 유지)만 다르다 — 소견서 '      ',
// 4번 칸 '      -'. 그 밖의 줄은 줄바꿈 하나까지 같다.
const EMPTY_NARRATIVE_LINES: readonly [string, string] = ['      ', '      -'];
const REPORT_EQUALS_EMR_SECTION_BUT_EMPTY_NARRATIVE = ['wrist', 'elbow'];

function differingLines(report: string, section: string): Array<[string, string]> {
  const left = report.split('\n');
  const right = section.split('\n');
  expect(left.length).toBe(right.length);
  return left.flatMap((line, i): Array<[string, string]> => (line === right[i] ? [] : [[line, right[i]]]));
}

/** calc의 상병 요약 분석 정리를 모두 빈 값으로(골든이 덮지 않는 분기 — 계획 F19 ②). 바꾼 개수를 돌려준다. */
function clearNarratives(calc: unknown): number {
  const { jobSummaries = [] } = calc as { jobSummaries?: Array<{ diagnosisSummaries?: Array<{ narrative?: string }> }> };
  let cleared = 0;
  for (const job of jobSummaries) {
    for (const summary of job.diagnosisSummaries || []) {
      summary.narrative = '';
      cleared += 1;
    }
  }
  return cleared;
}

describe('소견서 ≡ EMR 4번 칸 — 손목·팔꿈치(narrativeEmpty 줄만 예외)', () => {
  it.each(REPORT_EQUALS_EMR_SECTION_BUT_EMPTY_NARRATIVE)('%s: 골든·보강 환자 전원', (moduleId) => {
    useGoldenEnvironment();
    const { manifest, narrative } = moduleOf(moduleId);
    let checked = 0;
    for (const patient of allPatients()) {
      if (!(patient.data.activeModules || []).includes(moduleId)) continue;
      const calc = manifest.computeCalc({ shared: patient.data.shared, module: patient.data.modules[moduleId] || {} });
      for (const pair of differingLines(narrative.render('report', calc, {}), narrative.render('emrSection', calc, {}))) {
        expect(pair, patient.id).toEqual(EMPTY_NARRATIVE_LINES);
      }
      checked += 1;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it.each(REPORT_EQUALS_EMR_SECTION_BUT_EMPTY_NARRATIVE)('%s: 분석 정리가 빈 값이면 소견서는 빈 값, 4번 칸은 "-" — 그 줄만 다르다', (moduleId) => {
    useGoldenEnvironment();
    const { manifest, narrative } = moduleOf(moduleId);
    let checkedLines = 0;
    for (const patient of allPatients()) {
      if (!(patient.data.activeModules || []).includes(moduleId)) continue;
      const calc = manifest.computeCalc({ shared: patient.data.shared, module: patient.data.modules[moduleId] || {} });
      if (clearNarratives(calc) === 0) continue;
      const pairs = differingLines(narrative.render('report', calc, {}), narrative.render('emrSection', calc, {}));
      for (const pair of pairs) expect(pair, patient.id).toEqual(EMPTY_NARRATIVE_LINES);
      checkedLines += pairs.length;
    }
    expect(checkedLines).toBeGreaterThan(0);
  });
});
