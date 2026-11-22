// @vitest-environment jsdom
//
// 특성화 테스트(P2-56 첫 커밋, Phase 2 C6) — 실제 BatchImportModal을 6모듈을 등록한 상태로 돌려 지금 결과를 고정한다.
// G1b 골든(golden.calc.test.js)은 모달이 아니라 테스트 안의 사본을 돌리고, batchImport.latestMerge 테스트는 모듈 없이 돌린다 —
// 둘 다 덮지 않는 "모듈 applyRow가 섞인 기존 환자 병합"·"날짜 오류 행 건너뛰기"·"가져올 데이터 없음 판정"·changed·session을 여기서 덮는다.
// P2-56이 모달 로직을 runBatchImport로 옮길 때 결과가 같은지 이 테스트로 본다.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as XLSX from 'xlsx';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenBatchPatients } from '../../fixtures/goldenPatients';

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/elbow';
import '../../../modules/wrist';
import '../../../modules/spine';
import '../../../modules/cervical';
import { generateBatchRows, getBatchHeaders } from '../../utils/exportService';
import { BatchImportModal } from '../BatchImportModal';

vi.mock('../../utils/platform', async () => {
  const actual = await vi.importActual('../../utils/platform');
  return { ...actual, showAlert: vi.fn(async () => {}), showConfirm: vi.fn(async () => true) };
});
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ session: { mode: 'intranet', apiBaseUrl: 'https://x', accessToken: 'tok', user: { id: 'u1', role: 'doctor', organizationId: 'org1' } } }),
}));

import { showAlert, showConfirm } from '../../utils/platform';

beforeEach(() => {
  vi.clearAllMocks();
  useGoldenEnvironment();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function xlsxFile(rows) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '일괄입력');
  const buffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  return new File([buffer], 'import.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

async function loadFile(container, rows) {
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [xlsxFile(rows)] } });
}

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function summarize(payload, stats, existing) {
  const { newPatients, changed } = payload;
  return {
    stats,
    newPatients: newPatients.map(p => [p.data.shared.name, p.data.activeModules.join(','), p.data.shared.diagnoses.length, p.data.shared.jobs.length]),
    newPatientMeta: newPatients.map(p => p.meta ?? null)[0] ?? null,
    changed: changed.map(entry => [entry.patient.id, existing.indexOf(entry.base.patient)]),
    hash: sha({ newPatients, changed: changed.map(entry => entry.patient) }),
  };
}

describe('BatchImportModal(6모듈 등록) — 특성화', () => {
  it('기존 환자 병합(모듈 applyRow 포함)·새 환자·changed·session', async () => {
    const all = loadGoldenBatchPatients();
    const existing = all.slice(0, 3);
    const rows = [getBatchHeaders(), ...generateBatchRows(all)];
    const onImport = vi.fn();
    const onClose = vi.fn();
    const { container } = render(<BatchImportModal onClose={onClose} onImport={onImport} existingPatients={existing} />);
    await loadFile(container, rows);
    const button = screen.getByRole('button', { name: '가져오기' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(summarize(onImport.mock.calls[0][0], onImport.mock.calls[0][1], existing)).toEqual({
      stats: { newPatients: 3, newDiagnoses: 2, newJobs: 3, updatedAssessments: 0, skipped: 0, withDoctorName: 3 },
      newPatients: [['배치MDDM미평가', 'shoulder,cervical', 1, 2], ['배치WBV', 'spine', 1, 1], ['배치빈환자', '', 0, 0]],
      newPatientMeta: { organizationId: 'org1', ownerUserId: 'u1', createdBy: 'u1', updatedBy: 'u1', authMode: 'intranet', source: 'web', assignedDoctorUserId: 'u1' },
      // 행이 실제로 바꾼 기존 환자만, base는 넘긴 기존 환자 객체 그대로(인덱스).
      changed: [['golden-batch-elbow-wrist', 0], ['golden-batch-elbow-knee-spine', 1]],
      hash: 'ace8b827f7e8884f331c1ea70b77555ec34a736bbc02236fdfdfc654581aefdb',
    });
  });

  it('날짜 오류 행은 확인 뒤 건너뛴다(stats.skipped)', async () => {
    const all = loadGoldenBatchPatients();
    const headers = getBatchHeaders();
    const rows = [headers, ...generateBatchRows(all)];
    const birth = headers.indexOf('생년월일');
    rows[1][birth] = '1970-13-45';
    const onImport = vi.fn();
    const { container } = render(<BatchImportModal onClose={() => {}} onImport={onImport} existingPatients={[]} />);
    await loadFile(container, rows);
    const allow = await screen.findByRole('button', { name: '오류 행 제외하고 정상 행만 가져오기' });
    fireEvent.click(allow);
    await waitFor(() => expect(showConfirm).toHaveBeenCalledTimes(1));
    const button = screen.getByRole('button', { name: '가져오기' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(onImport).toHaveBeenCalledTimes(1));
    expect(summarize(onImport.mock.calls[0][0], onImport.mock.calls[0][1], [])).toEqual({
      stats: { newPatients: 6, newDiagnoses: 8, newJobs: 6, updatedAssessments: 3, skipped: 1, withDoctorName: 5 },
      newPatients: [
        ['배치팔꿈치손목', 'wrist,elbow', 2, 1],
        ['배치팔꿈치무릎척추', 'elbow,knee,spine', 3, 2],
        ['배치직업없음', 'cervical,spine', 1, 0],
        ['배치MDDM미평가', 'shoulder,cervical', 1, 2],
        ['배치WBV', 'spine', 1, 1],
        ['배치빈환자', '', 0, 0],
      ],
      newPatientMeta: { organizationId: 'org1', ownerUserId: 'u1', createdBy: 'u1', updatedBy: 'u1', authMode: 'intranet', source: 'web', assignedDoctorUserId: 'u1' },
      changed: [],
      hash: '9b226c9ecd74e32526e06e67fe751ae7657ce8ca02b73341e722e5253f89f180',
    });
  });

  it('이름이 있는 행이 없으면 "가져올 데이터가 없습니다"(onImport 없음)', async () => {
    const headers = getBatchHeaders();
    const row = headers.map(() => '');
    row[headers.indexOf('진단코드')] = 'M17.0';
    const onImport = vi.fn();
    const { container } = render(<BatchImportModal onClose={() => {}} onImport={onImport} existingPatients={[]} />);
    await loadFile(container, [headers, row]);
    const button = screen.getByRole('button', { name: '가져오기' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));
    expect(showAlert).toHaveBeenCalledWith('가져올 데이터가 없습니다.');
    expect(onImport).not.toHaveBeenCalled();
  });

  it('기존 환자와 같은 행만 있어 바뀐 것이 없으면 "가져올 데이터가 없습니다"', async () => {
    const all = loadGoldenBatchPatients();
    const target = all.find(p => p.id === 'golden-batch-wbv');
    const rows = [getBatchHeaders(), ...generateBatchRows([target])];
    const onImport = vi.fn();
    const { container } = render(<BatchImportModal onClose={() => {}} onImport={onImport} existingPatients={[target]} />);
    await loadFile(container, rows);
    const button = screen.getByRole('button', { name: '가져오기' });
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button);
    await waitFor(() => expect(showAlert).toHaveBeenCalledTimes(1));
    expect(showAlert).toHaveBeenCalledWith('가져올 데이터가 없습니다.');
    expect(onImport).not.toHaveBeenCalled();
  });
});
