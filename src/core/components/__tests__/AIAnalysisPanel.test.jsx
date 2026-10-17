// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MODEL_OPTIONS } from '@contracts/aiModels';

const auth = vi.hoisted(() => ({ session: { mode: 'intranet' } }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ session: auth.session }) }));
vi.mock('../../services/analysisClient', () => ({ analyzeAIRequest: vi.fn() }));

import { analyzeAIRequest } from '../../services/analysisClient';
import { AIAnalysisPanel } from '../AIAnalysisPanel.jsx';

const INPUT = { schemaVersion: 1, marker: 'structured' };

beforeEach(() => {
  auth.session = { mode: 'intranet' };
  vi.mocked(analyzeAIRequest).mockReset();
  vi.mocked(analyzeAIRequest).mockResolvedValue({ ok: true, status: 200, data: { text: 'AI 결과 텍스트' } });
});
afterEach(cleanup);

const run = async () => userEvent.setup().click(screen.getByRole('button', { name: 'AI 분석 실행' }));

function renderPanel(props = {}) {
  const generatePrompt = vi.fn(() => '보고서 전문 텍스트');
  const buildInput = vi.fn(() => INPUT);
  render(<AIAnalysisPanel generatePrompt={generatePrompt} systemPrompt="레거시 시스템 프롬프트" buildInput={buildInput} {...props} />);
  return { generatePrompt, buildInput };
}

describe('AIAnalysisPanel — 인트라넷', () => {
  it('모델 선택이 없고, 구조화 입력만 보낸다(보고서 전문은 만들지도 않는다)', async () => {
    const { generatePrompt, buildInput } = renderPanel();
    expect(screen.queryByLabelText('모델 선택')).toBeNull();
    await run();

    expect(buildInput).toHaveBeenCalledOnce();
    expect(generatePrompt).not.toHaveBeenCalled();
    expect(analyzeAIRequest).toHaveBeenCalledWith(expect.objectContaining({ input: INPUT, fullReport: undefined, session: auth.session }));
    const args = vi.mocked(analyzeAIRequest).mock.calls[0][0];
    expect(args.prompt).toBeUndefined();
    expect(args.systemPrompt).toBeUndefined();
    expect(args.model).toBeUndefined();
    expect(await screen.findByText('AI 결과 텍스트')).toBeTruthy();
  });

  it('서버가 내부 LLM이면(fullReportAllowed) 보고서 전문을 함께 보낸다', async () => {
    const { generatePrompt } = renderPanel({ fullReportAllowed: true });
    await run();
    expect(generatePrompt).toHaveBeenCalledOnce();
    expect(vi.mocked(analyzeAIRequest).mock.calls[0][0]).toMatchObject({ input: INPUT, fullReport: '보고서 전문 텍스트' });
  });

  it('입력을 만들지 못하면(null) 보고서 전문도 보내지 않는다 — 전문만 단독으로 나가는 일이 없다', async () => {
    const { generatePrompt } = renderPanel({ fullReportAllowed: true, buildInput: () => null });
    await run();
    expect(generatePrompt).not.toHaveBeenCalled();
    const args = vi.mocked(analyzeAIRequest).mock.calls[0][0];
    expect(args.input).toBeNull();
    expect(args.fullReport).toBeUndefined();
  });

  it('buildInput이 없으면 입력 없이 호출한다(안내 오류는 요청 계층이 만든다)', async () => {
    renderPanel({ buildInput: undefined });
    await run();
    expect(vi.mocked(analyzeAIRequest).mock.calls[0][0].input).toBeNull();
  });

  it('서버 오류 메시지를 화면에 표시한다', async () => {
    vi.mocked(analyzeAIRequest).mockResolvedValue({ ok: false, status: 502, data: { error: { message: 'AI 서버 응답 오류' } } });
    renderPanel();
    await run();
    expect(await screen.findByText('AI 서버 응답 오류')).toBeTruthy();
  });

  it('AI가 비활성이면 안내만 보여 주고 실행 버튼이 없다', () => {
    renderPanel({ aiAvailable: false });
    expect(screen.getByText('AI 분석이 이 서버에서 비활성화되어 있습니다.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'AI 분석 실행' })).toBeNull();
  });
});

describe('AIAnalysisPanel — 웹·Electron (hf7-3 전까지 기존 동작)', () => {
  beforeEach(() => { auth.session = { mode: 'standalone' }; });

  it('모델 선택지가 계약(MODEL_OPTIONS)과 같다', () => {
    renderPanel();
    const select = screen.getByLabelText('모델 선택');
    const rendered = [...select.querySelectorAll('option')].map((o) => ({ value: o.value, label: o.textContent }));
    const expected = MODEL_OPTIONS.flatMap((group) => group.options.map((o) => ({ value: o.value, label: o.label })));
    expect(rendered).toEqual(expected);
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(MODEL_OPTIONS.map((g) => g.group));
  });

  it('프롬프트·시스템 프롬프트·선택한 모델로 호출하고 구조화 입력은 쓰지 않는다', async () => {
    const { buildInput } = renderPanel();
    await userEvent.setup().selectOptions(screen.getByLabelText('모델 선택'), 'gemini-2.5-pro');
    await run();

    expect(buildInput).not.toHaveBeenCalled();
    expect(vi.mocked(analyzeAIRequest).mock.calls[0][0]).toMatchObject({
      prompt: '보고서 전문 텍스트', systemPrompt: '레거시 시스템 프롬프트', model: 'gemini-2.5-pro',
    });
    expect(vi.mocked(analyzeAIRequest).mock.calls[0][0].input).toBeUndefined();
  });

  it('프롬프트가 비어 있으면 호출하지 않는다', async () => {
    renderPanel({ generatePrompt: () => '' });
    await run();
    expect(analyzeAIRequest).not.toHaveBeenCalled();
  });
});
