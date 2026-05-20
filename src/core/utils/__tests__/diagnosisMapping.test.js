import { describe, expect, it } from 'vitest';
import {
  isValidDiagnosisModuleId,
  resolveDiagnosisModule,
  suggestModules,
} from '../diagnosisMapping.js';

describe('diagnosis module resolution', () => {
  it('lets a manual module override automatic mapping', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: 'shoulder' }, [])).toEqual({
      moduleId: 'shoulder',
      label: expect.any(String),
    });
  });

  it('lets explicit none block automatic mapping and fallback', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: '__none__' }, ['knee'])).toBeNull();
  });

  it('keeps automatic mapping when moduleId is null', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: null }, [])?.moduleId).toBe('knee');
  });

  it('falls back to the only active module when automatic mapping misses', () => {
    expect(resolveDiagnosisModule({ code: 'M79.3' }, ['knee'])?.moduleId).toBe('knee');
  });

  it('ignores invalid manual module ids and falls back to automatic mapping', () => {
    expect(resolveDiagnosisModule({ code: 'M17.1', moduleId: 'hip' }, [])?.moduleId).toBe('knee');
  });

  it('suggests manual modules and excludes explicit none', () => {
    expect(suggestModules([
      { code: 'XYZ', moduleId: 'spine' },
      { code: 'M17.1', moduleId: '__none__' },
    ])).toEqual(['spine']);
  });

  it('validates supported diagnosis module ids', () => {
    expect(isValidDiagnosisModuleId('knee')).toBe(true);
    expect(isValidDiagnosisModuleId('__none__')).toBe(false);
    expect(isValidDiagnosisModuleId('hip')).toBe(false);
  });
});
