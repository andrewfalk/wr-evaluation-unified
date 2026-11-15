// @vitest-environment jsdom
//
// 프리셋 내보내기와 화면 수명(계정 전환 수정 AS-4) — 프리셋을 불러오는 사이 화면이 내려가면(계정 전환) 이전 계정의 프리셋 파일을
// 만들지 않는다. StrictMode.
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../../services/presetRepository', () => ({
  exportPresetsToJSON: vi.fn(),
  importPresetsFromJSON: vi.fn(),
  loadAllPresets: vi.fn(),
}));

import { exportPresetsToJSON, loadAllPresets } from '../../services/presetRepository';
import { PresetsSection } from '../PresetsSection.jsx';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('PresetsSection — 내보내기', () => {
  it('불러오는 사이 화면이 내려가면 파일을 만들지 않는다', async () => {
    let resolve;
    loadAllPresets.mockImplementation(() => new Promise((r) => { resolve = r; }));
    const view = render(<StrictMode><PresetsSection session={{ mode: 'local' }} /></StrictMode>);
    fireEvent.click(screen.getByRole('button', { name: /내보내기/ }));
    view.unmount();
    await act(async () => { resolve({ merged: [{ jobName: 'x' }] }); });
    expect(exportPresetsToJSON).not.toHaveBeenCalled();
  });

  it('화면이 떠 있으면 지금처럼 파일을 만든다', async () => {
    loadAllPresets.mockResolvedValue({ merged: [{ jobName: 'x' }] });
    render(<StrictMode><PresetsSection session={{ mode: 'local' }} /></StrictMode>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /내보내기/ })); });
    expect(exportPresetsToJSON).toHaveBeenCalledWith([{ jobName: 'x' }]);
  });
});
