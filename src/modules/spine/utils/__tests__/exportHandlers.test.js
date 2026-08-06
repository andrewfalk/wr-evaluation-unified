import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as XLSX from 'xlsx';
import { spineExportHandlers, generateSpineReport } from '../exportHandlers';
import { createSpineModuleData, createTask, createVibrationInterval } from '../data';

// XLSX.writeFile은 브라우저 다운로드/Node fs 저장을 시도한다. 시트 내용만 검증하면
// 되므로 워크북 인자를 가로채고 실제 저장은 막는다.
let captured = null;
beforeEach(() => {
  captured = null;
  vi.spyOn(XLSX, 'writeFile').mockImplementation(wb => { captured = wb; });
});
afterEach(() => {
  vi.restoreAllMocks();
});

function makePatientData({ mddmStatus, vibrationExposureStatus, tasks, vibrationIntervals, returnConsiderations } = {}) {
  const module = {
    ...createSpineModuleData(),
    ...(mddmStatus !== undefined ? { mddmStatus } : {}),
    ...(vibrationExposureStatus !== undefined ? { vibrationExposureStatus } : {}),
    ...(tasks !== undefined ? { tasks } : {}),
    ...(vibrationIntervals !== undefined ? { vibrationIntervals } : {}),
    ...(returnConsiderations !== undefined ? { returnConsiderations } : {}),
  };
  return {
    shared: { name: '척추단독', gender: 'male', height: '170', weight: '70', jobs: [] },
    module,
  };
}

function firstSheetRows(wb) {
  const ws = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(ws, { header: 1 });
}

describe('spineExportHandlers.excelSingle — 특이 사항 메모는 MDDM/전신진동 어느 분기에서도 남는다', () => {
  it('MDDM만 평가: 메모가 MDDM 시트 말미에 붙는다', () => {
    const patientData = makePatientData({
      mddmStatus: 'present',
      vibrationExposureStatus: 'unknown',
      tasks: [createTask(0)],
      returnConsiderations: '허리 보호대 착용 권장',
    });
    spineExportHandlers.excelSingle(patientData);
    expect(captured.SheetNames).toEqual(['MDDM 평가']);
    const rows = firstSheetRows(captured);
    expect(rows).toContainEqual(['특이 사항 메모', '허리 보호대 착용 권장']);
  });

  it('전신진동만 평가: MDDM 시트가 없어도 메모가 남는다', () => {
    const patientData = makePatientData({
      mddmStatus: 'none',
      vibrationExposureStatus: 'present',
      tasks: [],
      vibrationIntervals: [createVibrationInterval(0)],
      returnConsiderations: '진동 노출 작업 시간 축소 권장',
    });
    spineExportHandlers.excelSingle(patientData);
    expect(captured.SheetNames).toEqual(['전신진동 평가']);
    const rows = firstSheetRows(captured);
    expect(rows).toContainEqual(['특이 사항 메모', '진동 노출 작업 시간 축소 권장']);
  });

  it('둘 다 미평가: 안내 시트뿐이어도 메모가 남는다', () => {
    const patientData = makePatientData({
      mddmStatus: 'unknown',
      vibrationExposureStatus: 'unknown',
      tasks: [],
      vibrationIntervals: [],
      returnConsiderations: '추적 관찰 필요',
    });
    spineExportHandlers.excelSingle(patientData);
    expect(captured.SheetNames).toEqual(['척추 평가']);
    const rows = firstSheetRows(captured);
    expect(rows).toContainEqual(['특이 사항 메모', '추적 관찰 필요']);
  });

  it('메모가 비어 있으면 행을 추가하지 않는다', () => {
    const patientData = makePatientData({
      mddmStatus: 'present',
      tasks: [createTask(0)],
      returnConsiderations: '',
    });
    spineExportHandlers.excelSingle(patientData);
    const rows = firstSheetRows(captured);
    expect(rows.some(row => row[0] === '특이 사항 메모')).toBe(false);
  });
});

describe('generateSpineReport — [특이 사항 메모] 절', () => {
  it('메모가 있으면 텍스트 리포트 말미에 절이 붙는다', () => {
    const patientData = makePatientData({
      mddmStatus: 'present',
      tasks: [createTask(0)],
      returnConsiderations: '허리 보호대 착용 권장',
    });
    const text = generateSpineReport(patientData);
    expect(text).toContain('[특이 사항 메모]\n허리 보호대 착용 권장');
  });

  it('메모가 없으면 절 자체가 없다', () => {
    const patientData = makePatientData({ mddmStatus: 'present', tasks: [createTask(0)] });
    const text = generateSpineReport(patientData);
    expect(text).not.toContain('[특이 사항 메모]');
  });
});
