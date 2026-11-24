// @vitest-environment jsdom
//
// FX-4(flagged, Phase 2 C7-a) — EMR 진료기록 일괄 추출의 완료 알림에 실패 사유를 사유별로 센다. 전에는 "실패 N명"만 보였다.
// 사유 = 실패 응답의 error(없으면 message, 둘 다 없으면 "사유 없음") · 등록번호 불일치는 고정 문구 · 예외는 "처리 중 오류".
// 많이 나온 순으로 3가지까지 "실패 사유: <문구> (N명)", 나머지는 "그 밖 N명". 사유 한 줄은 120자에서 자른다.
// 실패가 0이면 알림 문구는 전과 같다. 설치본(preload) 응답 모양은 바꾸지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useEMRIntegration } from '../useEMRIntegration.js';
import { usePatientsContainer } from '../../state/patientStore/usePatientsContainer';
import {
  EXTRACT_FAILURE_MAX_LENGTH, extractFailureReason, formatExtractFailures,
} from '../extractFailureReasons';

vi.mock('../../utils/platform', () => ({
  showAlert: vi.fn(async () => {}),
  showConfirm: vi.fn(async () => true),
}));

import { showAlert } from '../../utils/platform';

const SESSION = { mode: 'local' };

function patient(id) {
  return {
    id,
    data: {
      shared: { name: `환자-${id}`, patientNo: `N-${id}`, injuryDate: '', diagnoses: [], specialNotes: '' },
      modules: {}, activeModules: [],
    },
    sync: { syncStatus: 'local-only' },
  };
}

function renderEmr(ids) {
  const patients = ids.map(patient);
  return renderHook(() => {
    const store = usePatientsContainer(patients, { initialActiveId: ids[0], initialSelectedIds: new Set(ids) });
    const activePatient = store.patients.find(p => p.id === store.activeId) || null;
    const emr = useEMRIntegration({
      activePatient, patients: store.patients, selectedIds: store.selectedIds, session: SESSION,
      setPatients: store.setPatients, dirtyAssessmentPatientId: null,
    });
    return { ...store, emr };
  }, { wrapper: StrictMode });
}

async function runBatch(result) {
  let done = false;
  let running;
  await act(async () => { running = result.current.emr.handleEmrExtractBatch(); });
  running.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 40 && !done; i += 1) {
    await act(async () => { for (let j = 0; j < 8; j += 1) await Promise.resolve(); });
  }
  expect(done).toBe(true);
  return showAlert.mock.calls.at(-1)?.[0] ?? '';
}

const OK = (patientNo) => ({ success: true, patientNo, patientName: 'EMR이름', diseases: [] });
const GATE = '이 PC는 EMR 연동이 허용되지 않았습니다. 관리자에게 장치 승인을 요청하세요.';

let extract;
beforeEach(() => {
  vi.clearAllMocks();
  extract = vi.fn();
  window.electron = { extractRecord: extract };
});
afterEach(() => {
  cleanup();
  delete window.electron;
});

describe('FX-4 — EMR 일괄 추출 실패 사유', () => {
  it('전부 게이트 거부: 사유 한 줄로 모인다', async () => {
    extract.mockResolvedValue({ success: false, error: GATE });
    const { result } = renderEmr(['a', 'b', 'c']);
    const msg = await runBatch(result);
    expect(msg).toBe(`EMR 추출 완료: 3명 중 성공 0명, 실패 3명\n실패 사유: ${GATE} (3명)`);
  });

  it('일부 실패: 성공은 그대로 세고 실패한 사유만 적는다(error가 없으면 message)', async () => {
    extract.mockImplementation(async (patientNo) => (patientNo === 'N-b' ? { success: false, message: '진료기록분석지 화면을 찾을 수 없습니다' } : OK(patientNo)));
    const { result } = renderEmr(['a', 'b']);
    const msg = await runBatch(result);
    expect(msg).toBe('EMR 추출 완료: 2명 중 성공 1명, 실패 1명\n실패 사유: 진료기록분석지 화면을 찾을 수 없습니다 (1명)');
  });

  it('등록번호 불일치와 예외는 고정 문구로 묶는다, 사유가 없는 실패 응답은 "사유 없음"', async () => {
    extract.mockImplementation(async (patientNo) => {
      if (patientNo === 'N-a') return OK('N-zzz');
      if (patientNo === 'N-b') throw new Error('spawn C:\\path\\helper.exe ENOENT');
      if (patientNo === 'N-c') throw new Error('spawn D:\\other\\helper.exe EACCES');
      return { success: false };
    });
    const { result } = renderEmr(['a', 'b', 'c', 'd']);
    const msg = await runBatch(result);
    expect(msg).toBe([
      'EMR 추출 완료: 4명 중 성공 0명, 실패 4명',
      '실패 사유: 처리 중 오류 (2명)',
      '실패 사유: EMR 화면의 등록번호가 요청한 환자와 다름 (1명)',
      '실패 사유: 사유 없음 (1명)',
    ].join('\n'));
  });

  it('서로 다른 사유가 많으면 많이 나온 순(같으면 먼저 나온 순) 3가지까지, 나머지는 "그 밖 N명"', async () => {
    const reasons = { 'N-a': 'A', 'N-b': 'B', 'N-c': 'B', 'N-d': 'C', 'N-e': 'D', 'N-f': 'E', 'N-g': 'B' };
    extract.mockImplementation(async (patientNo) => ({ success: false, error: `사유 ${reasons[patientNo]}` }));
    const { result } = renderEmr(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
    const msg = await runBatch(result);
    expect(msg).toBe([
      'EMR 추출 완료: 7명 중 성공 0명, 실패 7명',
      '실패 사유: 사유 B (3명)',
      '실패 사유: 사유 A (1명)',
      '실패 사유: 사유 C (1명)',
      '그 밖 2명',
    ].join('\n'));
  });

  it('긴 사유는 한 줄로 펴고 120자에서 자른다', async () => {
    const long = `첫 줄\n${'가'.repeat(200)}`;
    extract.mockResolvedValue({ success: false, error: long });
    const { result } = renderEmr(['a']);
    const msg = await runBatch(result);
    const reasonLine = msg.split('\n')[1];
    const expected = `첫 줄 ${'가'.repeat(200)}`.slice(0, EXTRACT_FAILURE_MAX_LENGTH);
    expect(reasonLine).toBe(`실패 사유: ${expected}… (1명)`);
  });

  it('실패가 0이면 알림 문구는 전과 같다(사유 줄 없음)', async () => {
    extract.mockImplementation(async (patientNo) => OK(patientNo));
    const { result } = renderEmr(['a', 'b']);
    const msg = await runBatch(result);
    expect(msg).toBe('EMR 추출 완료: 2명 중 성공 2명, 실패 0명');
  });
});

describe('extractFailureReason · formatExtractFailures', () => {
  it('문자열이 아니거나 빈 사유는 다음 후보로, 없으면 "사유 없음"', () => {
    expect(extractFailureReason({ success: false, error: '  ', message: '메시지' })).toBe('메시지');
    expect(extractFailureReason({ success: false, error: { code: 1 } })).toBe('사유 없음');
    expect(extractFailureReason(null)).toBe('사유 없음');
    expect(extractFailureReason({ error: 'x'.repeat(EXTRACT_FAILURE_MAX_LENGTH) })).toBe('x'.repeat(EXTRACT_FAILURE_MAX_LENGTH));
  });

  it('실패가 없으면 빈 배열', () => {
    expect(formatExtractFailures(new Map())).toEqual([]);
  });
});
