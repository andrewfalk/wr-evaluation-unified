// 남는 쌍둥이 드리프트 방지(P2-71, Phase 2 C8) — 팔꿈치·손목에서 로직이 달라 두 벌로 남긴 화면 3종(상병 분기
// DiseaseSpecificFields · 결과 패널 본문 · 평가 화면)의 차이를 허용 목록(골든)으로 고정한다. 한쪽만 고치면 차이 묶음이 바뀌어
// 실패한다 — 그때는 다른 쪽도 같이 고칠지 판단하고, 차이가 의도한 것이면 `npx vitest run -u <이 파일>`로 갱신하고 PR에 이유를 적는다.
//
// 정규화는 **아래 목록에 적은 식별자·className 접두·폼 이름만** 공통 이름으로 바꾼다. `bk\d+_` 필드 이름과 한글 문자열은 건드리지
// 않는다 — 단순 치환(elbow → x)은 손목 결과 패널이 팔꿈치 클래스(`elbow-flag-pill`)를 쓰는 것 같은 비대칭을 가린다(K5·K8).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// vitest는 저장소 루트에서 돈다(sideLabels.test.ts와 같은 방식).
const ROOT = path.resolve('src/modules');

/** 모듈 → [바꿀 글자, 공통 이름]. 긴 것부터 바꾼다(접두가 겹치는 이름 때문에). */
const RENAMES: Record<'elbow' | 'wrist', Array<[string, string]>> = {
  elbow: [
    ['ElbowEvaluationProps', 'TwinEvaluationProps'],
    ['ElbowEvaluation', 'TwinEvaluation'],
    ['ElbowResultPanelProps', 'TwinResultPanelProps'],
    ['ElbowResultPanel', 'TwinResultPanel'],
    ['ElbowCalcResult', 'TwinCalcResult'],
    ['ElbowTemporalSequence', 'TwinTemporalSequence'],
    ['ElbowDiagnosisLike', 'TwinDiagnosisLike'],
    ['ElbowJobLike', 'TwinJobLike'],
    ['ElbowModuleDataInput', 'TwinModuleDataInput'],
    ['ElbowJob', 'TwinJob'],
    ['createElbowTemporalSequence', 'createTwinTemporalSequence'],
    ['syncElbowModuleData', 'syncTwinModuleData'],
    ['elbowDiagnoses', 'twinDiagnoses'],
    ['@wr/analytics-core/modules/elbow/index', '@wr/analytics-core/modules/twin/index'],
    ['elbow_recent_task_change', 'twin_recent_task_change'],
    ['elbow_improves_with_rest', 'twin_improves_with_rest'],
    ['classPrefix="elbow"', 'classPrefix="twin"'],
    ["classPrefix: 'elbow'", "classPrefix: 'twin'"],
    ['elbow-analysis-header', 'twin-analysis-header'],
    ['elbow-branch-radio-grid', 'twin-branch-radio-grid'],
    ['elbow-branch-radio-label', 'twin-branch-radio-label'],
    ['elbow-flag-pill', 'twin-flag-pill'],
    ['elbow-input-unit', 'twin-input-unit'],
    ['elbow-input-with-unit', 'twin-input-with-unit'],
    ['elbow-result-panel', 'twin-result-panel'],
    ['elbow-result-spacing', 'twin-result-spacing'],
    ['elbow-short-number-field', 'twin-short-number-field'],
  ],
  wrist: [
    ['WristEvaluationProps', 'TwinEvaluationProps'],
    ['WristEvaluation', 'TwinEvaluation'],
    ['WristResultPanelProps', 'TwinResultPanelProps'],
    ['WristResultPanel', 'TwinResultPanel'],
    ['WristCalcResult', 'TwinCalcResult'],
    ['WristTemporalSequence', 'TwinTemporalSequence'],
    ['WristDiagnosisLike', 'TwinDiagnosisLike'],
    ['WristJobLike', 'TwinJobLike'],
    ['WristModuleDataInput', 'TwinModuleDataInput'],
    ['WristJob', 'TwinJob'],
    ['syncWristModuleData', 'syncTwinModuleData'],
    ['wristDiagnoses', 'twinDiagnoses'],
    ['@wr/analytics-core/modules/wrist/index', '@wr/analytics-core/modules/twin/index'],
    ['wrist_recent_task_change', 'twin_recent_task_change'],
    ['wrist_improves_with_rest', 'twin_improves_with_rest'],
    ['classPrefix="wrist"', 'classPrefix="twin"'],
    ["classPrefix: 'wrist'", "classPrefix: 'twin'"],
    ['wrist-analysis-header', 'twin-analysis-header'],
    ['wrist-branch-radio-grid', 'twin-branch-radio-grid'],
    ['wrist-branch-radio-label', 'twin-branch-radio-label'],
    ['wrist-input-unit', 'twin-input-unit'],
    ['wrist-input-with-unit', 'twin-input-with-unit'],
    ['wrist-result-panel', 'twin-result-panel'],
    ['wrist-result-spacing', 'twin-result-spacing'],
    ['wrist-short-number-field', 'twin-short-number-field'],
  ],
};

const PAIRS = [
  ['DiseaseSpecificFields', 'elbow/components/DiseaseSpecificFields.jsx', 'wrist/components/DiseaseSpecificFields.jsx'],
  ['ResultPanel', 'elbow/components/ElbowResultPanel.tsx', 'wrist/components/WristResultPanel.tsx'],
  ['Evaluation', 'elbow/ElbowEvaluation.tsx', 'wrist/WristEvaluation.tsx'],
] as const;

function normalized(moduleId: 'elbow' | 'wrist', file: string): string[] {
  let text = readFileSync(path.join(ROOT, file), 'utf8').replace(/\r\n/g, '\n');
  const renames = [...RENAMES[moduleId]].sort((a, b) => b[0].length - a[0].length);
  for (const [from, to] of renames) text = text.split(from).join(to);
  return text.split('\n');
}

/** 줄 단위 최장 공통 부분열로 차이 묶음(연속한 다른 줄)을 만든다. 줄 번호는 적지 않는다(같은 줄이 늘고 줄어도 흔들리지 않게). */
function diffHunks(a: string[], b: string[]): Array<{ elbow: string[]; wrist: string[] }> {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks: Array<{ elbow: string[]; wrist: string[] }> = [];
  let current: { elbow: string[]; wrist: string[] } | null = null;
  let i = 0;
  let j = 0;
  const flush = () => {
    if (current) hunks.push(current);
    current = null;
  };
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      current = current || { elbow: [], wrist: [] };
      current.wrist.push(b[j]);
      j++;
    } else {
      current = current || { elbow: [], wrist: [] };
      current.elbow.push(a[i]);
      i++;
    }
  }
  flush();
  return hunks;
}

describe('P2-71 — 팔꿈치·손목 남는 쌍둥이의 허용 차이', () => {
  it.each(PAIRS)('%s', async (name, elbowFile, wristFile) => {
    const hunks = diffHunks(normalized('elbow', elbowFile), normalized('wrist', wristFile));
    expect(hunks.length, '두 벌이 같아졌다면 한 벌로 합칠 대상이다').toBeGreaterThan(0);
    await expect(JSON.stringify(hunks, null, 2) + '\n').toMatchFileSnapshot(`./__goldens__/twin-parity-${name}.json`);
  });

  it('정규화 목록의 글자는 실제로 그 파일들에 있다(낡은 목록 방지)', () => {
    for (const moduleId of ['elbow', 'wrist'] as const) {
      const text = PAIRS.map(([, elbowFile, wristFile]) => readFileSync(path.join(ROOT, moduleId === 'elbow' ? elbowFile : wristFile), 'utf8')).join('\n');
      for (const [from] of RENAMES[moduleId]) expect(text.includes(from), `${moduleId}: ${from}`).toBe(true);
    }
  });
});
