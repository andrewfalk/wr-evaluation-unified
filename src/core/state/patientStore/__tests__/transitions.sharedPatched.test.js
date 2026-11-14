// (flagged P2-39b) patient/sharedPatched — 요청 당시 식별정보와 같을 때만 적용 시점 shared에 병합한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isSharedPatchApplicable, patientTx } from '../transitions';

function p(id, shared, extra = {}) {
  return { id, data: { shared, modules: {}, activeModules: [] }, sync: { serverId: `s-${id}`, revision: 1, syncStatus: 'synced' }, ...extra };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-14T08:00:00.000Z'));
});
afterEach(() => { vi.useRealTimers(); });

describe('isSharedPatchApplicable', () => {
  const base = p('a', { patientNo: 'N1', injuryDate: '' });
  it.each([
    ['같은 등록번호·같은 재해일자', base, { patientNo: 'N1', injuryDate: '' }, true],
    ['재해일자 비교 안 함(다학제 회신)', p('a', { patientNo: 'N1', injuryDate: '2026-01-01' }), { patientNo: 'N1' }, true],
    ['등록번호 다름', base, { patientNo: 'N2', injuryDate: '' }, false],
    ['재해일자 다름', p('a', { patientNo: 'N1', injuryDate: '2026-01-01' }), { patientNo: 'N1', injuryDate: '' }, false],
    ['환자 없음', undefined, { patientNo: 'N1', injuryDate: '' }, false],
    ['가림 환자', { ...base, redacted: true }, { patientNo: 'N1', injuryDate: '' }, false],
    ['data 없음', { id: 'a' }, { patientNo: 'N1' }, false],
  ])('%s', (_label, patient, requested, expected) => {
    expect(isSharedPatchApplicable(patient, requested)).toBe(expected);
  });
});

describe('patient/sharedPatched', () => {
  const patch = shared => ({ ...shared, name: 'patched' });

  it('맞으면 적용 시점 shared에 patch를 적용하고 touch(서버 환자 → dirty), 다른 환자는 같은 참조', () => {
    const prev = [p('a', { patientNo: 'N1', injuryDate: '', note: 'latest' }), p('b', { patientNo: 'N2' })];
    const next = patientTx.sharedPatched({ id: 'a', requested: { patientNo: 'N1', injuryDate: '' }, patch, session: null })(prev);
    expect(next[0].data.shared).toEqual({ patientNo: 'N1', injuryDate: '', note: 'latest', name: 'patched' });
    expect(next[0].sync.syncStatus).toBe('dirty');
    expect(next[0].updatedAt).toBe('2026-11-14T08:00:00.000Z');
    expect(next[1]).toBe(prev[1]);
  });

  it('식별정보가 다르거나 환자가 없으면 prev를 그대로(touch 없음)', () => {
    const prev = [p('a', { patientNo: 'N-other', injuryDate: '' })];
    expect(patientTx.sharedPatched({ id: 'a', requested: { patientNo: 'N1', injuryDate: '' }, patch, session: null })(prev)).toBe(prev);
    expect(patientTx.sharedPatched({ id: 'zzz', requested: { patientNo: 'N1' }, patch, session: null })(prev)).toBe(prev);
  });
});
