// PR1 계획서 §1.1/§7.3/§9-item4 — Node(statsEngineLimits.ts)와 Python(protocol.py)의
// 상한 상수가 실제로 같은 값인지 대조한다. 두 값이 갈리면 "관리자가 상한을 올렸을 뿐인데
// 정상 요청이 PROCESS_ERROR로 죽는" 결함이 생긴다(3차 검토가 지적한 실제 재현 시나리오).
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MAX_STRING_LENGTH, MAX_TOTAL_VALUES, MAX_VALUES_PER_VARIABLE } from '../statsEngineLimits';

function extractPythonConstant(source: string, name: string): number {
  const match = source.match(new RegExp(`^${name}\\s*=\\s*(\\d+)`, 'm'));
  if (!match) throw new Error(`could not find Python constant ${name} in protocol.py`);
  return Number(match[1]);
}

describe('statsEngineLimits <-> protocol.py consistency', () => {
  const protocolPyPath = path.resolve(__dirname, '../../../services/stats-engine/protocol.py');
  const source = fs.readFileSync(protocolPyPath, 'utf8');

  it('MAX_VALUES_PER_VARIABLE matches', () => {
    expect(extractPythonConstant(source, 'MAX_VALUES_PER_VARIABLE')).toBe(MAX_VALUES_PER_VARIABLE);
  });

  it('MAX_TOTAL_VALUES matches', () => {
    expect(extractPythonConstant(source, 'MAX_TOTAL_VALUES')).toBe(MAX_TOTAL_VALUES);
  });

  it('MAX_STRING_LENGTH matches', () => {
    expect(extractPythonConstant(source, 'MAX_STRING_LENGTH')).toBe(MAX_STRING_LENGTH);
  });
});
