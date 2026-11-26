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
