// @vitest-environment jsdom
//
// 이 파일은 StepContent가 read-only일 때 씌우는 것과 동일한 capture 핸들러 조합
// (blockInteraction/blockMutatingKeys)을 최소 harness에 재현해 검증한다. BasicInfoForm 등
// 실제 스텝 트리 전체를 렌더하려면 세션/프리셋/모듈 레지스트리 등 무거운 목이 필요해
// 상호작용 로직 자체의 검증에는 적합하지 않다.
//
// 주의: jsdom은 select 방향키에 의한 selectedIndex 변경, number/range input의 스피너
// 증감(ArrowUp/Down) 같은 "네이티브 위젯" 동작을 구현하지 않는다(레이아웃 엔진이 없어
// 브라우저 렌더링에 의존하는 기본 동작이기 때문 — 실측 확인됨: 이 핸들러 없이도 jsdom에서는
// 애초에 값이 안 바뀐다). 그래서 이 파일에서는 "DOM 표시값이 그대로인지"가 아니라
// **실제 프로덕션 코드(blockMutatingKeys)가 이 키 입력에 대해 정확히 preventDefault/
// stopPropagation을 호출하는지**를 직접 검증한다 — 실제 브라우저에서 네이티브 값 변경을
// 막는 것과 동일한 메커니즘이며, jsdom의 렌더링 한계와 무관하게 우리 로직만 검증한다.
// checkbox의 클릭/Space 토글은 jsdom이 충실히 구현하므로 그 부분은 실제 DOM 상태(checked)
// 불변까지 함께 확인한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { blockInteraction, blockMutatingKeys, isReadOnlyAllowed } from '../StepContent.jsx';

afterEach(cleanup);

function ReadOnlyHarness({ onSelectChange = vi.fn(), onNumberChange = vi.fn(), onCheckboxChange = vi.fn(), onButtonClick = vi.fn(), onAllowedClick = vi.fn() }) {
  const [selectValue] = useState('a');
  const [numberValue] = useState('5');
  const [checked] = useState(false);

  return (
    <div
      data-testid="wrapper"
      onClickCapture={blockInteraction}
      onKeyDownCapture={blockMutatingKeys}
      onBeforeInputCapture={blockInteraction}
      onInputCapture={blockInteraction}
      onChangeCapture={blockInteraction}
    >
      <select aria-label="select" value={selectValue} onChange={onSelectChange}>
        <option value="a">A</option>
        <option value="b">B</option>
      </select>
      <input aria-label="number" type="number" value={numberValue} onChange={onNumberChange} />
      <input aria-label="checkbox" type="checkbox" checked={checked} onChange={onCheckboxChange} />
      <button type="button" onClick={onButtonClick}>실행</button>
      <button type="button" data-readonly-allow onClick={onAllowedClick}>허용된 버튼</button>
    </div>
  );
}

describe('isReadOnlyAllowed', () => {
  it('true when the event target has a data-readonly-allow ancestor', () => {
    render(<ReadOnlyHarness />);
    const allowedBtn = screen.getByText('허용된 버튼');
    const evt = { target: allowedBtn };
    expect(isReadOnlyAllowed(evt)).toBeTruthy();
  });

  it('false for a normal element', () => {
    render(<ReadOnlyHarness />);
    const btn = screen.getByText('실행');
    expect(isReadOnlyAllowed({ target: btn })).toBeFalsy();
  });
});

describe('blockMutatingKeys — keydown-level prevention (defaultPrevented)', () => {
  it('prevents default for ArrowDown on a select', () => {
    render(<ReadOnlyHarness />);
    const el = screen.getByLabelText('select');
    const evt = fireEvent.keyDown(el, { key: 'ArrowDown', bubbles: true, cancelable: true });
    // fireEvent.keyDown returns false when preventDefault() was called
    expect(evt).toBe(false);
  });

  it('prevents default for ArrowUp on a number input', () => {
    render(<ReadOnlyHarness />);
    const el = screen.getByLabelText('number');
    const evt = fireEvent.keyDown(el, { key: 'ArrowUp', bubbles: true, cancelable: true });
    expect(evt).toBe(false);
  });

  it('prevents default for Space on a checkbox and leaves it unchecked (jsdom faithfully toggles checkboxes natively)', async () => {
    const onCheckboxChange = vi.fn();
    render(<ReadOnlyHarness onCheckboxChange={onCheckboxChange} />);
    const el = screen.getByLabelText('checkbox');
    el.focus();
    const user = userEvent.setup();
    await user.keyboard(' ');
    expect(el.checked).toBe(false);
    expect(onCheckboxChange).not.toHaveBeenCalled();
  });

  it('does not toggle checkbox on click either (native click-toggle blocked)', async () => {
    const onCheckboxChange = vi.fn();
    render(<ReadOnlyHarness onCheckboxChange={onCheckboxChange} />);
    const el = screen.getByLabelText('checkbox');
    const user = userEvent.setup();
    await user.click(el);
    expect(el.checked).toBe(false);
    expect(onCheckboxChange).not.toHaveBeenCalled();
  });

  it('does NOT prevent default for Tab (focus movement must keep working)', () => {
    render(<ReadOnlyHarness />);
    const el = screen.getByLabelText('select');
    const evt = fireEvent.keyDown(el, { key: 'Tab', bubbles: true, cancelable: true });
    expect(evt).toBe(true); // not prevented
  });

  it('does NOT prevent default for Ctrl+C (copy must keep working)', () => {
    render(<ReadOnlyHarness />);
    const el = screen.getByLabelText('number');
    const evt = fireEvent.keyDown(el, { key: 'c', ctrlKey: true, bubbles: true, cancelable: true });
    expect(evt).toBe(true);
  });

  it('does NOT prevent default for ArrowLeft on a text-like caret position (checked via a plain div target lacking the matching control types)', () => {
    // select/number/checkbox 등 명시적 매칭 대상 외에는 건드리지 않는다는 걸
    // wrapper의 일반 컨테이너(div)에 대한 keydown으로 확인 — 스크롤 방향키 통로 보존.
    render(<ReadOnlyHarness />);
    const wrapper = screen.getByTestId('wrapper');
    const evt = fireEvent.keyDown(wrapper, { key: 'ArrowDown', bubbles: true, cancelable: true });
    expect(evt).toBe(true);
  });

  it('is bypassed for a matching control under a data-readonly-allow ancestor', () => {
    // data-readonly-allow 버튼 자체는 select/number가 아니라 매칭 대상이 아니므로,
    // 매칭 대상(select)에 data-readonly-allow 조상을 직접 붙여 예외 통로를 확인.
    const select = document.createElement('select');
    const allowedParent = document.createElement('div');
    allowedParent.setAttribute('data-readonly-allow', '');
    allowedParent.appendChild(select);
    document.body.appendChild(allowedParent);

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    blockMutatingKeys({ target: select, key: 'ArrowDown', preventDefault, stopPropagation });

    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();

    document.body.removeChild(allowedParent);
  });
});

describe('onChangeCapture — 2차 방어 (native mutation이 keydown 차단을 뚫고 일어난 경우)', () => {
  it('stops propagation so the app-level onChange never fires', () => {
    const onSelectChange = vi.fn();
    render(<ReadOnlyHarness onSelectChange={onSelectChange} />);
    const el = screen.getByLabelText('select');
    // 네이티브 값 변경이 이미 일어났다고 가정하고 change 이벤트만 발사(실제 브라우저에서
    // 방향키가 keydown 차단을 뚫었을 때 뒤따라오는 change 이벤트를 재현).
    fireEvent.change(el, { target: { value: 'b' } });
    expect(onSelectChange).not.toHaveBeenCalled();
  });
});

describe('blockInteraction — 클릭/붙여넣기 등 상호작용 차단', () => {
  it('blocks a plain button click', async () => {
    const onButtonClick = vi.fn();
    render(<ReadOnlyHarness onButtonClick={onButtonClick} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('실행'));
    expect(onButtonClick).not.toHaveBeenCalled();
  });

  it('allows a click on an element under data-readonly-allow', async () => {
    const onAllowedClick = vi.fn();
    render(<ReadOnlyHarness onAllowedClick={onAllowedClick} />);
    const user = userEvent.setup();
    await user.click(screen.getByText('허용된 버튼'));
    expect(onAllowedClick).toHaveBeenCalledTimes(1);
  });
});
