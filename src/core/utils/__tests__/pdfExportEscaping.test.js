// @vitest-environment jsdom
// The four per-module PDF exporters build HTML strings and assign them to `content.innerHTML`, then
// hand the element to html2pdf. Patient data comes from other users, EMR import and batch import, so
// every value must be escaped — otherwise a stored value such as `<img src=x onerror=…>` would run in
// the browser of whoever exports the PDF. Found while triaging the html2pdf.js advisory (2026-11-06:
// shoulder left birthDate/injuryDate/height/weight raw). NOTE: these per-module exportHandlers are
// registered but not called by the app today (the export menu uses core/utils/exportService.js), so
// this was a latent defect in unreachable code; the test keeps it from returning if they are wired up.
import { describe, expect, it, vi, beforeEach } from 'vitest';

let captured = null;
vi.mock('html2pdf.js', () => ({
  default: () => ({
    set: () => ({
      from: (el) => {
        captured = el;
        return { save: () => {} };
      },
    }),
  }),
}));

const { kneeExportHandlers } = await import('../../../modules/knee/utils/exportHandlers');
const { shoulderExportHandlers } = await import('../../../modules/shoulder/utils/exportHandlers');
const { elbowExportHandlers } = await import('../../../modules/elbow/utils/exportHandlers');
const { wristExportHandlers } = await import('../../../modules/wrist/utils/exportHandlers');

const P = '<img src=x onerror="window.__pwned=1">';

const shared = {
  name: P, gender: 'male', birthDate: P, injuryDate: P, height: P, weight: P,
  evaluationDate: P, hospitalName: P, department: P, doctorName: P, specialNotes: P,
  diagnoses: [{
    code: P, name: P, side: 'both',
    confirmedRight: 'confirmed', confirmedLeft: 'confirmed',
    assessmentRight: 'low', assessmentLeft: 'low',
    reasonRight: ['other'], reasonRightOther: P, reasonLeft: ['other'], reasonLeftOther: P,
  }],
  jobs: [{ id: 'j1', jobName: P }],
};
const patient = { shared, modules: {} };

const jobSummaryCalc = {
  temporalFlagItems: [{ label: P }],
  jobSummaries: [{
    jobName: P,
    diagnosisSummaries: [{
      diagnosis: { code: P, name: P }, branchLabel: P, flagItems: [{ label: P }], narrative: P, riskFactorSentence: P,
    }],
  }],
};

const cases = [
  ['knee', () => kneeExportHandlers.pdf(patient, { age: P, bmi: P, relatedness: { min: P, max: P }, cumulativeBurden: P })],
  ['shoulder', () => shoulderExportHandlers.pdf(patient, { age: P, bmi: P, totals: [] })],
  ['elbow', () => elbowExportHandlers.pdf(patient, jobSummaryCalc)],
  ['wrist', () => wristExportHandlers.pdf(patient, jobSummaryCalc)],
];

describe('PDF export HTML escapes patient data', () => {
  beforeEach(() => { captured = null; });

  it.each(cases)('%s: no element is created from patient data', (_name, run) => {
    run();
    expect(captured).not.toBeNull();
    // Escaped input stays text; unescaped input would have become a real <img> element.
    expect(captured.querySelector('img')).toBeNull();
    expect(captured.querySelectorAll('[onerror]')).toHaveLength(0);
    expect(captured.textContent).toContain(P);
  });
});
