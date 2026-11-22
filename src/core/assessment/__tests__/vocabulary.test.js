// 평가 어휘 특성화(P2-52, Phase 2 C6) — core가 쓰는 선택지·문구 함수(지금은 무릎 모듈 것)의 값을 고정한다.
// P2-52가 이것들을 src/core/assessment/vocabulary.ts로 옮길 때 값이 같은지 본다.
import { describe, expect, it } from 'vitest';
import { KLG_OPTIONS, LOW_REASON_OPTIONS } from '../../../modules/knee/utils/data';
import { getReasonText, getStatusText } from '../../../modules/knee/utils/calculations';

describe('평가 어휘(특성화)', () => {
  it('KLG_OPTIONS', () => {
    expect(KLG_OPTIONS).toEqual([
      { value: '', label: '선택' },
      { value: 'N/A', label: '해당없음' },
      { value: '1', label: '1등급' },
      { value: '2', label: '2등급' },
      { value: '3', label: '3등급' },
      { value: '4', label: '4등급' },
    ]);
  });

  it('LOW_REASON_OPTIONS', () => {
    expect(LOW_REASON_OPTIONS).toEqual([
      { value: 'unrelated', label: '신체부담과 관련없는 상병' },
      { value: 'unconfirmed', label: '상병 미확인' },
      { value: 'ageMild', label: '연령대비 경미' },
      { value: 'delayed', label: '업무중단 후 상당기간 경과' },
      { value: 'lowBurden', label: '누적 신체부담 낮음' },
      { value: 'belowThreshold', label: '부담 정도가 최소 문턱값을 넘지 못함' },
      { value: 'other', label: '기타' },
    ]);
  });

  it('getStatusText', () => {
    expect(['confirmed', 'unconfirmed', '', undefined, null, 'yes'].map(getStatusText))
      .toEqual(['확인', '미확인', '-', '-', '-', '-']);
  });

  it('getReasonText', () => {
    expect(getReasonText(['unrelated', 'unconfirmed', 'ageMild', 'mild', 'delayed', 'lowBurden', 'belowThreshold'], ''))
      .toBe('신체부담과 관련없는 상병\n상병 미확인\n연령대비 경미\n상병 미확인/연령대비 경미\n업무중단 후 상당기간 경과\n누적 신체부담 낮음\n부담 정도가 최소 문턱값을 넘지 못함');
    expect(getReasonText(['other'], '직접 입력')).toBe('기타 (직접 입력)');
    expect(getReasonText(['other'])).toBe('기타 ()');
    expect(getReasonText(['custom-code'], '')).toBe('custom-code');
    expect(getReasonText('delayed')).toBe('업무중단 후 상당기간 경과');
    expect(getReasonText('')).toBe('-');
    expect(getReasonText([])).toBe('-');
    expect(getReasonText(null)).toBe('-');
    expect(getReasonText(undefined)).toBe('-');
  });
});
