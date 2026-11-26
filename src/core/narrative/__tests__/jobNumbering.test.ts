// 게이트 C(P2-66c·d)에서 골든이 덮지 않는 서술 분기(계획 F19). 픽스처는 건드리지 않고, 골든 환자를 복사해 바꾸거나
// 가짜 calc로 확인한다.
// ① 부담 지표 이름(label)이 없는 경추 flag는 키(key)로 나온다(ADR 0001 B10).
// ③ 일부 직력이 신체부담평가 미포함인 환자에서, 모듈 블록의 직력 번호가 세 변형 모두 [직업력]의 번호와 같다(표 A 22행).
import { afterEach, describe, expect, it, vi } from 'vitest';
import '../../../modules';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenPatients } from '../../fixtures/goldenPatients';
import { getModule } from '../../modules/registry';
import { generateUnifiedEMR } from '../../utils/emrReport';
import { generateUnifiedReport } from '../../utils/reportGenerator';

interface Job { id: string; jobName?: string; excludeFromAnalysis?: boolean }
interface GoldenPatient {
  id: string;
  data: { shared: { jobs: Job[] } & Record<string, unknown>; modules: Record<string, unknown>; activeModules: string[] };
}

afterEach(() => {
  vi.useRealTimers();
});

/** [직업력]의 "- 직력N: 직종명 | …" → 번호 → 직종명 */
function jobHistoryNumbers(text: string): Map<number, string> {
  const section = text.split('[직업력]\n')[1].split('\n\n')[0];
  const map = new Map<number, string>();
  for (const line of section.split('\n')) {
    const match = /^- 직력(\d+): (.+?) \| /.exec(line);
    if (match) map.set(Number(match[1]), match[2]);
  }
  return map;
}

/** 모듈 머리글(`<…>` 한 줄) 뒤 그 블록 안의 "- 직력N: 직종명" 줄 → [번호, 직종명] */
function blockJobLines(text: string, heading: string): Array<[number, string]> {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `${heading} 블록`).toBeGreaterThanOrEqual(0);
  const lines = text.slice(start + heading.length + 2).split('\n');
  const out: Array<[number, string]> = [];
  for (const line of lines) {
    if (/^ *<[^<>]*>$/.test(line) || line.startsWith('[ 업무관련성')) break;
    const match = /^- 직력(\d+): (.+)$/.exec(line);
    if (match) out.push([Number(match[1]), match[2]]);
  }
  return out;
}

function patientWithFirstJobExcluded(id: string): GoldenPatient {
  const patient = (loadGoldenPatients() as GoldenPatient[]).find(p => p.id === id);
  if (!patient) throw new Error(`골든 환자 ${id} 없음`);
  patient.data.shared.jobs[0].excludeFromAnalysis = true;
  return patient;
}

describe('일부 직력 미포함 — 모듈 블록 직력 번호 = [직업력] 번호(세 변형)', () => {
  it.each([
    ['cervical', '<경추(목)>', '00000000-0000-4000-8000-000000000170'],
  ])('%s', (_moduleId, heading, patientId) => {
    useGoldenEnvironment();
    const patient = patientWithFirstJobExcluded(patientId);
    const excludedName = patient.data.shared.jobs[0].jobName;
    const report = generateUnifiedReport(patient);
    const { b6, b8 } = generateUnifiedEMR(patient);
    const history = jobHistoryNumbers(report);
    expect(jobHistoryNumbers(b6)).toEqual(history);
    expect(Array.from(history.values()).pop()).toBe(excludedName); // 미포함 직력은 [직업력] 맨 끝

    for (const [variant, text] of [['report', report], ['emrSection', b6], ['emrSummary', b8]] as const) {
      const lines = blockJobLines(text, heading);
      expect(lines.length, variant).toBe(history.size - 1);
      for (const [number, name] of lines) {
        expect(history.get(number), `${variant} 직력${number}`).toBe(name);
        expect(name, variant).not.toBe(excludedName);
      }
    }
  });
});

describe('경추: 이름 없는 부담 지표는 키로(B10)', () => {
  it('세 변형 모두 label이 없으면 key, 있으면 label', () => {
    const narrative = getModule('cervical')?.narrative;
    if (!narrative) throw new Error('경추 서술 없음');
    const calc = {
      jobSummaries: [{
        jobName: '시험 직종',
        flagItems: [{ key: 'neckFlexion' }, { key: 'other', label: '목 굽힘' }],
        missingFields: [],
        narrative: '정리',
        conclusionText: '결론',
      }],
    };
    expect(narrative.render('report', calc, {})).toContain('      부담 요인: neckFlexion, 목 굽힘\n');
    expect(narrative.render('emrSection', calc, {})).toContain('      부담 요인: neckFlexion, 목 굽힘\n');
    expect(narrative.render('emrSummary', calc, {})).toBe('\n<경추(목)>\n- 직력1: 시험 직종\n  부담 요인: neckFlexion, 목 굽힘\n');
  });
});
