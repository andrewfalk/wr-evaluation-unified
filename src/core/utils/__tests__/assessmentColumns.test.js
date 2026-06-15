import { describe, expect, it, vi } from 'vitest';

// html2pdf.js의 UMD 빌드는 브라우저 전역 `self`를 참조하므로 node 테스트 환경에서
// exportService.js import 시 ReferenceError가 발생한다. export row 생성 로직만
// 검증하므로 PDF 생성 부분은 모킹한다.
vi.mock('html2pdf.js', () => ({ default: () => ({}) }));

import { BATCH_HEADERS, generateBatchRows } from '../exportService';

function col(name) {
  const index = BATCH_HEADERS.indexOf(name);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

function makePatient(diagnoses) {
  return {
    data: {
      shared: { name: '홍길동', diagnoses, jobs: [] },
      modules: {},
      activeModules: ['knee', 'spine'],
    },
  };
}

describe('generateBatchRows: 상병 상태/업무관련성/수직분포 컬럼', () => {
  const diag1 = {
    code: 'M17.1', name: '무릎관절증', side: 'right',
    confirmedRight: 'confirmed', confirmedLeft: '',
    assessmentRight: 'low', assessmentLeft: '',
    reasonRight: ['lowBurden', 'other'], reasonRightOther: '기타텍스트',
  };
  const diag2 = {
    code: 'M51.1', name: '요추간판장애', moduleId: 'spine', side: '',
    verticalDistribution: 'confirmed', concomitantSpondylosis: 'unconfirmed',
  };

  const rows = generateBatchRows([makePatient([diag1, diag2])]);

  it('상병당 1개 행을 생성한다', () => {
    expect(rows).toHaveLength(2);
  });

  it('첫 진단: 상병상태/업무관련성/사유 컬럼을 채운다', () => {
    const row = rows[0];
    expect(row[col('상병상태(우)')]).toBe('확인');
    expect(row[col('상병상태(좌)')]).toBe('');
    expect(row[col('업무관련성(우)')]).toBe('낮음');
    expect(row[col('업무관련성(좌)')]).toBe('');
    expect(row[col('업무관련성낮음사유(우)')]).toBe('누적 신체부담 낮음\n기타 (기타텍스트)');
    expect(row[col('업무관련성낮음사유(좌)')]).toBe('');
    expect(row[col('수직분포원리')]).toBe('');
    expect(row[col('동반척추증')]).toBe('');
  });

  it('두번째 진단(spine): 수직분포원리/동반척추증을 채우고, 상병상태/업무관련성은 빈값(\'\')', () => {
    const row = rows[1];
    expect(row[col('상병상태(우)')]).toBe('');
    expect(row[col('업무관련성(우)')]).toBe('');
    expect(row[col('업무관련성낮음사유(우)')]).toBe('');
    expect(row[col('수직분포원리')]).toBe('확인');
    expect(row[col('동반척추증')]).toBe('미확인');
  });
});
