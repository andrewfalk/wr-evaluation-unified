import { describe, expect, it } from 'vitest';
import { splitInjectPayload } from '../emrPayload.js';

describe('splitInjectPayload', () => {
  it('passes fields through unchanged and reports no source when _source is absent', () => {
    const { emrFields, source } = splitInjectPayload({ txtSyth1Cont: 'a', txtJobCusCont: 'b' });
    expect(emrFields).toEqual({ txtSyth1Cont: 'a', txtJobCusCont: 'b' });
    expect(source).toBeUndefined();
  });

  it('strips _source from emrFields and returns it separately when valid', () => {
    const { emrFields, source } = splitInjectPayload({ txtSyth1Cont: 'a', _source: 'edited' });
    expect(emrFields).toEqual({ txtSyth1Cont: 'a' });
    expect(emrFields._source).toBeUndefined();
    expect(source).toBe('edited');
  });

  it('accepts "auto" as a valid source', () => {
    const { source } = splitInjectPayload({ _source: 'auto' });
    expect(source).toBe('auto');
  });

  it('normalizes an out-of-range _source value to "auto"', () => {
    const { emrFields, source } = splitInjectPayload({ txtSyth1Cont: 'a', _source: 'tampered' });
    expect(source).toBe('auto');
    expect(emrFields).toEqual({ txtSyth1Cont: 'a' });
  });

  it('passes through non-object input without throwing', () => {
    expect(splitInjectPayload(null)).toEqual({ emrFields: null, source: undefined });
    expect(splitInjectPayload(undefined)).toEqual({ emrFields: undefined, source: undefined });
  });
});
