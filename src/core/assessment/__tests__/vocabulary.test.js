// 평가 어휘(P2-52, Phase 2 C6) — core가 쓰는 선택지·문구 함수. 첫 커밋에서 무릎 모듈의 값으로 고정한 표를 그대로 두고
// 대상을 src/core/assessment/vocabulary.ts로 바꿨다(값이 같다). 무릎·어깨 data.js의 옛 경로는 같은 객체를 다시 내보낸다.
import { describe, expect, it } from 'vitest';
import { KLG_OPTIONS, LOW_REASON_OPTIONS, getReasonText, getStatusText } from '../vocabulary';
import * as kneeData from '../../../modules/knee/utils/data';
import * as shoulderData from '../../../modules/shoulder/utils/data';

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

  it('무릎·어깨 옛 경로는 같은 객체를 다시 내보낸다', () => {
    expect(kneeData.KLG_OPTIONS).toBe(KLG_OPTIONS);
    expect(kneeData.LOW_REASON_OPTIONS).toBe(LOW_REASON_OPTIONS);
    expect(shoulderData.LOW_REASON_OPTIONS).toBe(LOW_REASON_OPTIONS);
  });
});
