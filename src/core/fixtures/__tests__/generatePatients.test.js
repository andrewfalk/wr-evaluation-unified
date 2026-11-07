import { describe, it, expect } from 'vitest';
import { generatePatients, generatedPatientId } from '../generatePatients.js';
import { loadGoldenPatients } from '../goldenPatients.js';

describe('generatePatients (P0-13 render baseline input)', () => {
  it('is deterministic for the same n', () => {
    expect(JSON.stringify(generatePatients(40, loadGoldenPatients()))).toBe(JSON.stringify(generatePatients(40, loadGoldenPatients())));
  });

  it('cycles the golden patients and only changes id and patientNo', () => {
    const golden = loadGoldenPatients();
    const out = generatePatients(golden.length + 2, golden);
    expect(out).toHaveLength(golden.length + 2);
    const wrapped = out[golden.length];
    const source = golden[0];
    expect(wrapped.id).toBe(generatedPatientId(golden.length));
    expect(wrapped.data.shared.patientNo).toBe(`WR9${String(golden.length + 1).padStart(5, '0')}`);
    const strip = p => ({ ...p, id: null, data: { ...p.data, shared: { ...p.data.shared, patientNo: null } } });
    expect(strip(wrapped)).toEqual(strip(source));
  });

  it('gives every patient a unique id and patient number', () => {
    const out = generatePatients(500, loadGoldenPatients());
    expect(new Set(out.map(p => p.id)).size).toBe(500);
    expect(new Set(out.map(p => p.data.shared.patientNo)).size).toBe(500);
    expect(out[499].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('does not mutate the base and returns independent copies', () => {
    const base = [{ id: 'x', data: { shared: { patientNo: 'A' }, modules: { knee: { v: 1 } } } }];
    const out = generatePatients(2, base);
    out[0].data.modules.knee.v = 99;
    expect(base[0].data.modules.knee.v).toBe(1);
    expect(out[1].data.modules.knee.v).toBe(1);
    expect(base[0].id).toBe('x');
  });

  it('rejects invalid n and empty base', () => {
    expect(() => generatePatients(-1, [{}])).toThrow();
    expect(() => generatePatients(1.5, [{}])).toThrow();
    expect(() => generatePatients(1, [])).toThrow();
    expect(() => generatePatients(1)).toThrow();
    expect(generatePatients(0, [{}])).toEqual([]);
  });
});
