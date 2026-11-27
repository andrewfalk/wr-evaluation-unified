// 일괄 내보내기는 모듈 등록 순서와 무관하다(P2-55a, Phase 2 C6 — 계획 원칙 3).
// 서로 다른 등록 순서(앱 순서·골든 테스트 순서·그 역순)로 6모듈을 새로 등록하고 머리글·골든 환자 행이 같은지 본다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../../fixtures/goldenEnv';
import { loadGoldenBatchPatients, loadGoldenPatients } from '../../fixtures/goldenPatients';

const ORDERS = [
  ['knee', 'spine', 'cervical', 'shoulder', 'elbow', 'wrist'], // 앱(src/modules/index.ts)
  ['knee', 'shoulder', 'elbow', 'wrist', 'spine', 'cervical'], // 골든 테스트
  ['wrist', 'elbow', 'shoulder', 'cervical', 'spine', 'knee'], // 역순 섞기
];

async function exportWith(order) {
  vi.resetModules();
  for (const id of order) await import(`../../../modules/${id}/index`);
  const exportService = await import('../../utils/exportService');
  const { getAllModules } = await import('../../moduleRegistry');
  return {
    registered: getAllModules().map(mod => mod.id),
    headers: exportService.getBatchHeaders(),
    rows: exportService.generateBatchRows([...loadGoldenPatients(), ...loadGoldenBatchPatients()]),
  };
}

beforeEach(() => {
  useGoldenEnvironment();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('일괄 내보내기 — 등록 순서 무관', () => {
  it('세 가지 등록 순서에서 머리글·행이 같다', async () => {
    const results = [];
    for (const order of ORDERS) results.push(await exportWith(order));
    expect(results.map(result => result.registered)).toEqual(ORDERS);
    expect(results[0].headers).toHaveLength(124);
    for (const result of results.slice(1)) {
      expect(result.headers).toEqual(results[0].headers);
      expect(result.rows).toEqual(results[0].rows);
    }
  });
});
