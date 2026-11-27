// @vitest-environment jsdom
//
// 무릎·어깨 JobTab의 extras 갱신 특성화(P2-67a, Phase 2 C8) — find-or-create(`handleExtra`)를 공용 함수(upsertJobExtra)로
// 바꾸기 전에, 실제 JobTab을 그려 입력을 바꿨을 때 onChange가 받는 배열을 그대로 얼린다.
//   · 이미 extras가 있는 직력의 값 바꾸기(그 자리 교체 — 다른 직력·지운 직력의 extras 순서 유지)
//   · extras가 없는 직력에 처음 입력(팩토리 값 + 그 필드, 배열 끝에 추가)
//   · 무릎 체크박스(켜기·끄기)
// 규칙(의도한 출력 변경에서만 갱신, 리팩터링에서는 갱신 금지): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { useGoldenEnvironment } from '../../core/fixtures/goldenEnv';
import { JobTab as KneeJobTab } from '../knee/components/JobTab';
import { JobTab as ShoulderJobTab } from '../shoulder/components/JobTab';

function goldenJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + '\n';
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SHARED_JOBS = [
  { id: 'job-a', jobName: '용접공' },
  { id: 'job-b', jobName: '' },
];

const KNEE_EXTRAS = [
  { sharedJobId: 'job-removed', weight: '1', squatting: '1', evidenceSources: [], stairs: true, kneeTwist: false, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false },
  { sharedJobId: 'job-a', weight: '20', squatting: '30', evidenceSources: ['면담'], stairs: false, kneeTwist: true, startStop: false, tightSpace: false, kneeContact: false, jumpDown: false, extraField: '보존' },
];

const SHOULDER_EXTRAS = [
  { sharedJobId: 'job-removed', overheadHours: '9', repetitiveMediumHours: '', repetitiveFastHours: '', heavyLoadCount: '', heavyLoadSeconds: '', vibrationHours: '', evidenceSources: [] },
  { sharedJobId: 'job-a', overheadHours: '1.5', repetitiveMediumHours: '2', repetitiveFastHours: '', heavyLoadCount: '10', heavyLoadSeconds: '', vibrationHours: '', evidenceSources: ['면담'], extraField: '보존' },
];

type Change = { target: { value?: string; checked?: boolean } };

// 직력 카드(job-card)의 n번째 input을 바꿔 onChange의 첫 인자를 돌려준다. 매번 새로 그린다(handleExtra는 props의 jobExtras를 쓴다).
function changeInput(
  renderTab: (onChange: (extras: unknown) => void) => JSX.Element,
  cardIndex: number,
  inputIndex: number,
  change: Change,
): unknown {
  const onChange = vi.fn();
  const { container, unmount } = render(renderTab(onChange));
  const card = container.querySelectorAll('.job-card')[cardIndex];
  const input = card.querySelectorAll('input')[inputIndex];
  if (input.type === 'checkbox') fireEvent.click(input);
  else fireEvent.change(input, change);
  unmount();
  expect(onChange).toHaveBeenCalledTimes(1);
  return onChange.mock.calls[0][0];
}

describe('P2-67a — 무릎·어깨 JobTab extras 갱신', () => {
  it('무릎', async () => {
    const renderTab = (onChange: (extras: unknown) => void) => (
      <KneeJobTab sharedJobs={SHARED_JOBS} jobExtras={KNEE_EXTRAS} onChange={onChange} errors={null} />
    );
    const result = {
      // input 순서: 쪼그려앉기 · 중량물 · 체크박스 6개(계단·비틀림·출발정지·좁은공간·접촉·뛰어내리기)
      existingSquatting: changeInput(renderTab, 0, 0, { target: { value: '45' } }),
      existingWeight: changeInput(renderTab, 0, 1, { target: { value: '' } }),
      existingCheckboxOn: changeInput(renderTab, 0, 2, { target: {} }),
      existingCheckboxOff: changeInput(renderTab, 0, 3, { target: {} }),
      missingSquatting: changeInput(renderTab, 1, 0, { target: { value: '10' } }),
      missingWeight: changeInput(renderTab, 1, 1, { target: { value: '5' } }),
      missingCheckboxOn: changeInput(renderTab, 1, 7, { target: {} }),
    };
    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/twin-job-extras-knee.json');
  });

  it('어깨', async () => {
    const renderTab = (onChange: (extras: unknown) => void) => (
      <ShoulderJobTab sharedJobs={SHARED_JOBS} jobExtras={SHOULDER_EXTRAS} onChange={onChange} errors={null} />
    );
    const result: Record<string, unknown> = {};
    // input 순서: 오버헤드 · 반복 중간 · 반복 고도 · 진동 · 중량물 횟수 · 중량물 시간
    ['overheadHours', 'repetitiveMediumHours', 'repetitiveFastHours', 'vibrationHours', 'heavyLoadCount', 'heavyLoadSeconds'].forEach((field, i) => {
      result[`existing:${field}`] = changeInput(renderTab, 0, i, { target: { value: String(i + 0.5) } });
      result[`missing:${field}`] = changeInput(renderTab, 1, i, { target: { value: String(i + 1) } });
    });
    result.existingCleared = changeInput(renderTab, 0, 0, { target: { value: '' } });
    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/twin-job-extras-shoulder.json');
  });
});
