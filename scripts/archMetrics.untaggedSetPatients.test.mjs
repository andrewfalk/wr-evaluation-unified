// scripts/arch-metrics.mjs — untaggedSetPatients(REFACTORING_ROADMAP Phase 2 P2-32, 게이트 A 계획 §5).
// 환자 목록 쓰기는 꼬리표 전이(`setPatients(patientTx.…)`)만 — 그 밖의 인자로 부르는 호출 수를 센다.
import { describe, expect, it } from 'vitest';
import { scanFile } from './arch-metrics.mjs';

describe('arch-metrics untaggedSetPatients', () => {
  it('전이가 아닌 인자(값·updater·변수)로 부르는 호출을 센다 — 여러 줄 호출도 1회', () => {
    const src = [
      'setPatients([]);',
      'setPatients(prev => prev.map(p => p));',
      'setPatients(nextPatients);',
      'setPatients(',
      '  prev => [...prev, p],',
      ');',
      'setPatients(patientTx.dataEdited({ id }));',
      'setPatients( patientTx . appended({ patients }));',
    ].join('\n');
    expect(scanFile('src/core/hooks/useX.js', src).untaggedSetPatients).toBe(4);
  });

  it('주석·다른 이름(setServerPatients, x.setPatients 정의 등)은 세지 않는다', () => {
    const src = [
      '// setPatients(prev => prev)',
      '/* setPatients([]) */',
      'setServerPatients(all);',
      'const { patients, setPatients } = usePatientsContainer();',
      'usePatientSync({ patients, setPatients });',
    ].join('\n');
    expect(scanFile('src/App.jsx', src).untaggedSetPatients).toBeUndefined();
  });

  it('컨테이너 계층(src/core/state/)과 테스트는 세지 않는다', () => {
    expect(scanFile('src/core/state/patientStore/usePatientsContainer.ts', 'setPatients(x);').untaggedSetPatients).toBeUndefined();
    expect(scanFile('src/core/hooks/__tests__/x.test.jsx', 'setPatients([]);').untaggedSetPatients).toBeUndefined();
  });
});
