// @vitest-environment jsdom
// Golden (characterization) tests — G2: the batch sheet (BATCH_HEADERS + every row of
// generateBatchRows); G3: the narrative outputs (unified report text, EMR fields, AI input);
// G4: the files the app's export menu produces (core/utils/exportService.js — single workbook,
// selected/all ZIPs, batch-format workbooks, empty template). REFACTORING_ROADMAP P0-9.
// The per-module exportHandlers are not covered: the app never calls them.
// Rules (update only for intended output changes, never in a refactor): src/core/fixtures/goldenEnv.js
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenPatients } from '../../fixtures/goldenPatients';

vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

// Capture what the export functions hand to SheetJS / JSZip instead of writing files.
const captured = vi.hoisted(() => ({ writeFile: [], write: [], zips: [] }));
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writeFile: (wb, fileName) => { captured.writeFile.push({ wb, fileName }); },
    // Tag each buffer so the ZIP entry it lands in can be tied back to its workbook.
    write: (wb, opts) => { captured.write.push({ wb, opts }); return { goldenWorkbookIndex: captured.write.length - 1 }; },
  };
});
vi.mock('jszip', () => ({
  default: class FakeZip {
    constructor() { this.entries = []; captured.zips.push(this); }
    file(name, data) { this.entries.push({ name, workbookIndex: data?.goldenWorkbookIndex ?? null }); return this; }
    async generateAsync() { return new Blob([]); }
  },
}));

const MODULE_IDS = ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'];

function goldenJson(value) {
  return JSON.stringify(value, (_key, v) => (typeof v === 'number' && !Number.isFinite(v) ? `__${v}__` : v), 2) + '\n';
}

let XLSX;
let exportService;
let reportGenerator;
let emrReport;
let aiInput;
let downloads;

// A workbook as plain data: every sheet's rows (header:1, empty cells kept) and column widths.
function workbookData(wb) {
  return wb.SheetNames.map((name) => ({
    sheet: name,
    cols: wb.Sheets[name]['!cols'] || null,
    rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }),
  }));
}

beforeEach(async () => {
  useGoldenEnvironment();
  captured.writeFile.length = 0;
  captured.write.length = 0;
  captured.zips.length = 0;
  downloads = [];
  URL.createObjectURL = vi.fn(() => 'blob:golden');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() { downloads.push(this.download); });
  for (const id of MODULE_IDS) await import(`../../../modules/${id}/index.js`);
  XLSX = await import('xlsx');
  exportService = await import('../exportService');
  reportGenerator = await import('../reportGenerator');
  emrReport = await import('../emrReport');
  aiInput = await import('../aiInput');
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('G2 — batch sheet', () => {
  it('BATCH_HEADERS and every generateBatchRows row', async () => {
    const rows = exportService.generateBatchRows(loadGoldenPatients());
    await expect(goldenJson({ headers: exportService.BATCH_HEADERS, rows })).toMatchFileSnapshot('./__goldens__/batch-rows.json');
  });
});

describe('G3 — narrative outputs per patient', () => {
  it('unified report text', async () => {
    const out = {};
    for (const p of loadGoldenPatients()) out[p.id] = reportGenerator.generateUnifiedReport(p);
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/report-text.json');
  });

  it('EMR: generateUnifiedEMR fields, injection data, consult-reply data', async () => {
    const out = {};
    for (const p of loadGoldenPatients()) {
      out[p.id] = {
        unified: emrReport.generateUnifiedEMR(p),
        fieldData: emrReport.generateEMRFieldData(p),
        consultReply: emrReport.generateConsultReplyFieldData(p),
      };
    }
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/emr.json');
  });

  it('AI analysis input', async () => {
    const out = {};
    for (const p of loadGoldenPatients()) out[p.id] = aiInput.buildAiInputResult(p);
    await expect(goldenJson(out)).toMatchFileSnapshot('./__goldens__/ai-input.json');
  });
});

describe('G4 — export menu files (exportService)', () => {
  it('single, selected ZIP, all ZIP, batch formats and template', async () => {
    const patients = loadGoldenPatients();
    const result = {};

    exportService.exportSingle(patients[0]);
    exportService.exportSingle(patients[patients.length - 1]);
    result.single = captured.writeFile.splice(0).map(({ wb, fileName }) => ({ fileName, workbook: workbookData(wb) }));

    const selectedIds = new Set([patients[0].id, patients[1].id, patients[2].id]);
    await exportService.exportSelected(patients, selectedIds);
    await exportService.exportBatch(patients);
    // Each ZIP entry with the workbook that was actually written into it (Codex review of #200).
    result.zips = captured.zips.map((zip, i) => ({
      download: downloads[i],
      entries: zip.entries.map(({ name, workbookIndex }) => ({
        name,
        writeOptions: captured.write[workbookIndex]?.opts ?? null,
        workbook: workbookIndex === null ? null : workbookData(captured.write[workbookIndex].wb),
      })),
    }));

    exportService.exportBatchFormatSingle(patients[0]);
    exportService.exportBatchFormatSelected(patients, selectedIds);
    exportService.exportBatchFormatAll(patients);
    exportService.exportBatchTemplate();
    result.batchFormats = captured.writeFile.splice(0).map(({ wb, fileName }) => ({ fileName, workbook: workbookData(wb) }));

    await expect(goldenJson(result)).toMatchFileSnapshot('./__goldens__/export-files.json');
  });
});
