// @vitest-environment jsdom
//
// P2-39b(flagged) — EMR 일괄 추출·다학제 회신 결과를 "기다리는 동안 바뀐 최신 값"에 병합한다(REFACTORING_ROADMAP Phase 2,
// 게이트 A 계획 "flagged 수정 설계 ②"). 옮기기 전에는 추출 시작(회신은 확인창을 띄운) 시점 사본으로 만든 shared로 통째 교체해,
// 기다리는 동안 고친 다른 필드·추가한 상병이 되돌아가고, 그사이 등록번호·재해일자가 바뀌면 바뀐 식별정보를 옛 값으로 되돌리며
// 다른 환자·신청건의 기록을 섞었다. 진짜 상태(환자 상태 컨테이너 + useEMRIntegration), StrictMode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import { patientTx } from '../../state/patientStore/transitions';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { showAlert, showConfirm } from '../../utils/platform';

const SESSION = { mode: 'local' };

function patient(id, shared = {}) {
  return {
    id,
    data: {
      shared: { name: `old-${id}`, patientNo: `N-${id}`, injuryDate: '', diagnoses: [{ id: `${id}-d1`, code: 'M1', name: 'm1', side: '' }], specialNotes: '', ...shared },
      modules: {}, activeModules: [],
    },
    sync: { syncStatus: 'local-only' },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function renderEmr(initialPatients, initialActiveId) {
  return renderHook(() => {
    const store = usePatientsContainer(initialPatients, { initialActiveId });
    const activePatient = store.patients.find(p => p.id === store.activeId) || null;
    const emr = useEMRIntegration({
      activePatient, patients: store.patients, selectedIds: store.selectedIds, session: SESSION,
      setPatients: store.setPatients, dirtyAssessmentPatientId: null,
    });
    return { ...store, emr };
  }, { wrapper: StrictMode });
}

const sharedOf = (result, id) => result.current.patients.find(p => p.id === id)?.data?.shared;
const editShared = (result, id, patch) => act(() => {
  result.current.setPatients(patientTx.dataEdited({
    id, session: SESSION, edit: d => ({ ...d, shared: typeof patch === 'function' ? patch(d.shared) : { ...d.shared, ...patch } }),
  }));
});
const lastAlert = () => showAlert.mock.calls.at(-1)?.[0] ?? '';

async function flush(n = 8) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}

// 훅이 커밋 배리어(전이 적용 여부를 커밋 뒤에 확인)를 기다리므로, act 안에서 그 promise를 await하지 않고
// act를 여러 번 돌려 렌더·effect를 흘려보낸다(act는 콜백이 끝나야 쌓인 렌더를 처리한다).
async function settle(promise, rounds = 20) {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < rounds && !done; i += 1) {
    await act(async () => { await flush(); });
  }
  expect(done).toBe(true);
}

let extract;
let consult;
beforeEach(() => {
  vi.clearAllMocks();
  extract = vi.fn();
  consult = vi.fn();
  window.electron = { extractRecord: extract, extractConsultation: consult };
});
afterEach(() => {
  cleanup();
  delete window.electron;
});

const EMR_OK = (patientNo, extra = {}) => ({
  success: true, patientNo, patientName: 'EMR이름', birthDate: '1970-01-01', gender: 'M',
  diseases: [{ code: 'M2', name: 'm2' }], ...extra,
});

describe('P2-39b — EMR 일괄 추출 결과를 최신 값에 병합', () => {
  it('① 추출 대기 중 사용자가 고친 다른 필드·추가한 상병이 유지된다(추출 값은 그대로 적용)', async () => {
    const pending = deferred();
    extract.mockReturnValue(pending.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleEmrExtractBatch(); await flush(); });
    expect(extract).toHaveBeenCalledWith('N-a', '');
    editShared(result, 'a', s => ({ ...s, specialNotes: '대기 중 메모', diagnoses: [...s.diagnoses, { id: 'a-d9', code: 'M9', name: 'm9', side: '' }] }));
    await act(async () => { pending.resolve(EMR_OK('N-a')); await flush(); });
    await settle(running);

    const shared = sharedOf(result, 'a');
    expect(shared.name).toBe('EMR이름');
    expect(shared.birthDate).toBe('1970-01-01');
    expect(shared.specialNotes).toBe('대기 중 메모');
    expect(shared.diagnoses.map(d => d.code)).toEqual(['M1', 'M9', 'M2']);
    expect(lastAlert()).toContain('성공 1명');
  });

  it('② 대기 중 환자등록번호가 바뀌면 적용하지 않고 "건너뜀"으로 보고한다', async () => {
    const pending = deferred();
    extract.mockReturnValue(pending.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleEmrExtractBatch(); await flush(); });
    editShared(result, 'a', { patientNo: 'N-other' });
    await act(async () => { pending.resolve(EMR_OK('N-a')); await flush(); });
    await settle(running);

    const shared = sharedOf(result, 'a');
    expect(shared.patientNo).toBe('N-other');
    expect(shared.name).toBe('old-a');
    expect(shared.diagnoses.map(d => d.code)).toEqual(['M1']);
    expect(lastAlert()).toContain('건너뜀 1명');
    expect(lastAlert()).toContain('추출 중 환자 정보가 바뀌어 건너뜀');
  });

  it('②-b 대기 중 재해일자가 바뀌면(요청 때 비어 있었는데 채워짐) 적용하지 않는다 — 다른 신청건 기록이 섞이지 않게', async () => {
    const pending = deferred();
    extract.mockReturnValue(pending.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleEmrExtractBatch(); await flush(); });
    editShared(result, 'a', { injuryDate: '2026-03-03' });
    await act(async () => { pending.resolve(EMR_OK('N-a', { accidentDate: '2025-01-01' })); await flush(); });
    await settle(running);

    const shared = sharedOf(result, 'a');
    expect(shared.injuryDate).toBe('2026-03-03');
    expect(shared.name).toBe('old-a');
    expect(lastAlert()).toContain('건너뜀 1명');
  });

  it('③ 대기 중 환자가 삭제됐으면 적용하지 않고 건너뜀으로 보고한다(성공으로 세지 않음)', async () => {
    const pending = deferred();
    extract.mockReturnValue(pending.promise);
    const { result } = renderEmr([patient('a'), patient('b')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleEmrExtractBatch(); await flush(); });
    act(() => { result.current.setPatients(patientTx.replacedAll({ patients: [result.current.patients[1]] })); });
    await act(async () => { pending.resolve(EMR_OK('N-a')); await flush(); });
    await settle(running);

    expect(result.current.patients.map(p => p.id)).toEqual(['b']);
    expect(sharedOf(result, 'b').name).toBe('old-b');
    expect(lastAlert()).toContain('성공 0명');
    expect(lastAlert()).toContain('건너뜀 1명');
  });

  it('②-c 등록번호 변경과 추출 완료가 같은 배치에 들어와도 적용되지 않은 결과를 성공으로 세지 않는다(#323 Codex)', async () => {
    const pending = deferred();
    extract.mockReturnValue(pending.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleEmrExtractBatch(); await flush(); });
    await act(async () => {
      result.current.setPatients(patientTx.dataEdited({ id: 'a', session: SESSION, edit: d => ({ ...d, shared: { ...d.shared, patientNo: 'N-other' } }) }));
      pending.resolve(EMR_OK('N-a'));
      await flush();
    });
    await settle(running);

    expect(sharedOf(result, 'a').patientNo).toBe('N-other');
    expect(sharedOf(result, 'a').name).toBe('old-a');
    expect(lastAlert()).toContain('성공 0명');
    expect(lastAlert()).toContain('건너뜀 1명');
  });

  it('응답 등록번호 교차검증(다른 환자 데이터)은 그대로 실패로 센다', async () => {
    extract.mockResolvedValue(EMR_OK('N-zzz'));
    const { result } = renderEmr([patient('a')], 'a');
    let run;
    act(() => { run = result.current.emr.handleEmrExtractBatch(); });
    await settle(run);
    expect(sharedOf(result, 'a').name).toBe('old-a');
    expect(lastAlert()).toContain('실패 1명');
    expect(lastAlert()).not.toContain('건너뜀');
  });

  it('바뀐 것이 없으면 옮기기 전과 같은 결과(재해일자 비어 있으면 추출 값으로 채움·상병 코드 중복 제거)', async () => {
    extract.mockResolvedValue(EMR_OK('N-a', { accidentDate: '2025-05-05', diseases: [{ code: 'M1', name: 'dup' }, { code: 'M3', name: 'm3' }], medicalRecord: '기록' }));
    const { result } = renderEmr([patient('a')], 'a');
    let run;
    act(() => { run = result.current.emr.handleEmrExtractBatch(); });
    await settle(run);
    const shared = sharedOf(result, 'a');
    expect(shared.injuryDate).toBe('2025-05-05');
    expect(shared.medicalRecord).toBe('기록');
    expect(shared.diagnoses.map(d => d.code)).toEqual(['M1', 'M3']);
    expect(lastAlert()).toBe('EMR 추출 완료: 1명 중 성공 1명, 실패 0명');
  });
});

describe('P2-39b — 다학제 회신을 최신 값에 병합', () => {
  it('④ 확인창이 떠 있는 동안 고친 회신 칸 뒤에 덧붙인다(그사이 고친 다른 필드도 유지)', async () => {
    consult.mockResolvedValue({ success: true, consultations: [{ department: '정형외과', content: 'EMR 회신' }] });
    const confirm = deferred();
    showConfirm.mockReturnValueOnce(confirm.promise);
    const { result } = renderEmr([patient('a', { consultReplyOrtho: '' })], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleExtractConsultation(); await flush(); });
    editShared(result, 'a', { consultReplyOrtho: '직접 쓴 회신', specialNotes: '메모' });
    await act(async () => { confirm.resolve(true); await flush(); });
    await settle(running);

    const shared = sharedOf(result, 'a');
    expect(shared.consultReplyOrtho).toBe('직접 쓴 회신\n---\nEMR 회신');
    expect(shared.specialNotes).toBe('메모');
  });

  it('④-c 등록번호 변경과 확인이 같은 배치에 들어와도 저장하지 않은 회신을 성공으로 알리지 않는다(#323 Codex)', async () => {
    consult.mockResolvedValue({ success: true, consultations: [{ department: '재활의학과', content: 'EMR 회신' }] });
    const confirm = deferred();
    showConfirm.mockReturnValueOnce(confirm.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleExtractConsultation(); await flush(); });
    await act(async () => {
      result.current.setPatients(patientTx.dataEdited({ id: 'a', session: SESSION, edit: d => ({ ...d, shared: { ...d.shared, patientNo: 'N-other' } }) }));
      confirm.resolve(true);
      await flush();
    });
    await settle(running);

    expect(sharedOf(result, 'a').consultReplyRehab).toBeUndefined();
    expect(lastAlert()).toContain('환자 정보가 바뀌어');
    expect(lastAlert()).not.toContain('회신을 가져왔습니다');
  });

  it('④-b 확인창이 떠 있는 동안 등록번호가 바뀌면 저장하지 않고 알린다', async () => {
    consult.mockResolvedValue({ success: true, consultations: [{ department: '신경외과', content: 'EMR 회신' }] });
    const confirm = deferred();
    showConfirm.mockReturnValueOnce(confirm.promise);
    const { result } = renderEmr([patient('a')], 'a');

    let running;
    await act(async () => { running = result.current.emr.handleExtractConsultation(); await flush(); });
    editShared(result, 'a', { patientNo: 'N-other' });
    await act(async () => { confirm.resolve(true); await flush(); });
    await settle(running);

    const shared = sharedOf(result, 'a');
    expect(shared.patientNo).toBe('N-other');
    expect(shared.consultReplyNeuro).toBeUndefined();
    expect(lastAlert()).toContain('환자 정보가 바뀌어');
  });
});
