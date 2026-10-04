// @vitest-environment jsdom
// 신규 환자 등록 마법사: 필수값이 비어도 "다음"은 막지 않고(이동 허용), 지나간 단계의 미해결 항목을
// 마법사 헤더 아래 요약으로 계속 안내하며, 값을 고치면 안내가 사라지는지 확인한다.
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../moduleRegistry', () => ({ getAllModules: () => [] }));
vi.mock('../PresetSearch', () => ({ PresetSearch: () => null }));

import { IntakeWizard } from '../IntakeWizard.jsx';
import { createSharedData } from '../../utils/data';

afterEach(cleanup);

function Harness({ initial }) {
  const [shared, setShared] = useState(() => initial || createSharedData());
  return (
    <IntakeWizard
      shared={shared}
      onSharedChange={setShared}
      hasExistingPatients={false}
      onCancel={() => {}}
      onComplete={() => {}}
      errors={{}}
      presets={[]}
      presetMeta={{}}
      presetError={null}
      session={null}
    />
  );
}

const summary = () => screen.queryByRole('status');

describe('IntakeWizard — 필수값 안내(이동은 허용)', () => {
  it('처음에는 안내가 없고, 빈 상태에서 "다음"을 눌러도 이동하며 요약이 뜬다', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(summary()).toBeNull();

    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    // 상병 단계로 이동했다(이동을 막지 않음).
    expect(screen.getByText('신청 상병')).toBeTruthy();
    // 기본정보 3개 항목이 요약에 남아 있다(폼은 사라졌지만 안내는 유지).
    const box = within(summary());
    expect(box.getByText(/확인이 필요한 항목 3개/)).toBeTruthy();
    expect(box.getByRole('button', { name: /이름 — 이름을 입력해 주세요/ })).toBeTruthy();
    expect(box.getByRole('button', { name: /생년월일 — 필수 입력입니다/ })).toBeTruthy();
    expect(box.getByRole('button', { name: /재해일자 — 필수 입력입니다/ })).toBeTruthy();
  });

  it('다음 단계에서도 요약이 유지되고, 요약 항목을 누르면 해당 단계로 돌아가 필드별 안내가 다시 보인다', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    await user.click(screen.getByRole('button', { name: /다음: 모듈 선택/ })); // 상병도 비었지만 이동 허용
    expect(screen.getByText('평가 모듈 선택')).toBeTruthy();
    // 기본정보 3 + 상병 존재 검사 1
    expect(within(summary()).getByText(/확인이 필요한 항목 4개/)).toBeTruthy();

    await user.click(within(summary()).getByRole('button', { name: /이름 — / }));
    expect(screen.getByText('기본 신상 정보와 평가 기준 날짜를 입력합니다.')).toBeTruthy();
    // 필드별 안내(폼 내부 .error-message)
    expect(document.querySelectorAll('.error-message').length).toBe(3);
  });

  it('값을 채우면 해당 안내가 사라지고, 전부 해결되면 요약이 없어진다', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    await user.click(within(summary()).getByRole('button', { name: /이름 — / }));

    // "이름 *" 입력칸은 label 텍스트로 찾는다.
    const nameField = screen.getByText('이름 *').closest('.form-group').querySelector('input');
    expect(nameField).toBeTruthy();
    await user.type(nameField, '홍길동');
    expect(within(summary()).queryByRole('button', { name: /이름 — / })).toBeNull();
    expect(within(summary()).getByText(/확인이 필요한 항목 2개/)).toBeTruthy();

    const birth = screen.getByText('생년월일 *').closest('.form-group').querySelector('input');
    const injury = screen.getByText('재해일자 *').closest('.form-group').querySelector('input');
    await user.type(birth, '1980-01-01');
    await user.type(injury, '2020-05-05');
    expect(summary()).toBeNull();
  });

  it('미래 날짜처럼 값이 있어도 잘못된 경우 사유가 요약에 나온다', async () => {
    const user = userEvent.setup();
    const initial = createSharedData();
    initial.name = '홍길동';
    initial.birthDate = '2999-01-01';
    initial.injuryDate = '2020-05-05';
    render(<Harness initial={initial} />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    expect(within(summary()).getByRole('button', { name: /생년월일 — 오늘 이후의 날짜는 사용할 수 없습니다/ })).toBeTruthy();
  });

  it('공백만 있는 이름은 입력되지 않은 것으로 안내한다', async () => {
    const user = userEvent.setup();
    const initial = createSharedData();
    initial.name = '   ';
    initial.birthDate = '1980-01-01';
    initial.injuryDate = '2020-05-05';
    render(<Harness initial={initial} />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    expect(within(summary()).getByText(/확인이 필요한 항목 1개/)).toBeTruthy();
  });
});

describe('IntakeWizard — 상병 단계 안내', () => {
  function readyInfo(diagnoses) {
    const s = createSharedData();
    s.name = '홍길동';
    s.birthDate = '1980-01-01';
    s.injuryDate = '2020-05-05';
    s.diagnoses = diagnoses;
    return s;
  }
  const row = (id, code, name) => ({ id, code, name, moduleId: null, side: '' });

  it('코드만 입력한 행은 그 행의 진단명 아래에 안내하고, 요약에는 "상병 #N: 진단명"으로 나온다', async () => {
    const user = userEvent.setup();
    render(<Harness initial={readyInfo([row('a', 'M17.0', '무릎'), row('b', 'M54.5', '')])} />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    await user.click(screen.getByRole('button', { name: /다음: 모듈 선택/ }));
    expect(within(summary()).getByRole('button', { name: /상병 #2: 진단명 — 진단명을 입력해 주세요/ })).toBeTruthy();

    await user.click(within(summary()).getByRole('button', { name: /상병 #2: 진단명/ }));
    const card = document.getElementById('diagnosis-card-b');
    expect(card).toBeTruthy();
    expect(within(card).getByText('진단명을 입력해 주세요')).toBeTruthy();
    // 정상 행에는 안내가 없다.
    expect(within(document.getElementById('diagnosis-card-a')).queryByText(/입력해 주세요/)).toBeNull();
  });

  it('정상 상병 1건 + 완전히 빈 추가 행이면 안내가 없다', async () => {
    const user = userEvent.setup();
    render(<Harness initial={readyInfo([row('a', 'M17.0', '무릎'), row('b', '', '')])} />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    await user.click(screen.getByRole('button', { name: /다음: 모듈 선택/ }));
    expect(summary()).toBeNull();
  });

  it('상병이 전부 비어 있으면 목록 상단에 존재 검사 안내가 나온다', async () => {
    const user = userEvent.setup();
    render(<Harness initial={readyInfo([row('a', '', '')])} />);
    await user.click(screen.getByRole('button', { name: /다음: 상병 입력/ }));
    await user.click(screen.getByRole('button', { name: /다음: 모듈 선택/ }));
    expect(within(summary()).getByRole('button', { name: /상병 — 상병이 입력되지 않았습니다/ })).toBeTruthy();
    await user.click(within(summary()).getByRole('button', { name: /상병 — / }));
    expect(screen.getAllByText('상병이 입력되지 않았습니다').length).toBeGreaterThan(0);
  });
});
