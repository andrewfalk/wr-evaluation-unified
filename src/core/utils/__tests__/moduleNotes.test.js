import { describe, expect, it } from 'vitest';
import { selectModuleNote } from '../moduleNotes';

describe('selectModuleNote', () => {
  it('값이 있는 활성 모듈을 우선한다', () => {
    const modules = { knee: { returnConsiderations: '무릎 메모' }, spine: { returnConsiderations: '' } };
    expect(selectModuleNote(modules, ['spine', 'knee'])).toBe('무릎 메모');
  });

  it('활성 모듈에 값이 없으면 비활성 모듈 값으로 폴백한다 (레거시 데이터 보존)', () => {
    const modules = { knee: { returnConsiderations: '옛 무릎 메모' } };
    expect(selectModuleNote(modules, ['spine'])).toBe('옛 무릎 메모');
  });

  it('활성·비활성 값이 갈리면 활성이 이긴다', () => {
    const modules = {
      knee: { returnConsiderations: '비활성 값' },
      spine: { returnConsiderations: '활성 값' },
    };
    expect(selectModuleNote(modules, ['spine'])).toBe('활성 값');
  });

  it('비활성 모듈끼리 값이 갈리면 레거시 고정 순서(knee가 cervical보다 우선)를 따른다', () => {
    const modules = {
      cervical: { returnConsiderations: '경추 값' },
      knee: { returnConsiderations: '무릎 값' },
    };
    expect(selectModuleNote(modules, [])).toBe('무릎 값');
  });

  it('어떤 모듈에도 값이 없으면 빈 문자열을 반환한다', () => {
    const modules = { knee: {}, spine: { returnConsiderations: '' } };
    expect(selectModuleNote(modules, ['knee', 'spine'])).toBe('');
  });

  it('modules/activeModules가 없어도 안전하게 빈 문자열을 반환한다', () => {
    expect(selectModuleNote()).toBe('');
    expect(selectModuleNote(undefined, undefined)).toBe('');
  });
});
