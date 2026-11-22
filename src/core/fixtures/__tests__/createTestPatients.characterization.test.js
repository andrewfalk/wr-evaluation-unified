// 특성화 테스트(P2-53, Phase 2 C6) — createTestPatients() 출력을 골든 환경(고정 시계·난수·UUID)에서 고정한다.
// P2-53이 wrist 생성 함수 import를 wrist 매니페스트의 devFixtures로 바꿀 때 출력이 같은지 본다.
// 값은 이 파일 안에 적는다(새 골든 JSON을 만들지 않는다): 환자 수, 환자별 요약, 전체 출력의 SHA-256.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useGoldenEnvironment } from '../goldenEnv';

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/elbow';
import '../../../modules/wrist';
import '../../../modules/spine';
import '../../../modules/cervical';

const EXPECTED_COUNT = 27;
const EXPECTED_SUMMARY = [
  ['김철수', 'knee', 3, 2],
  ['이영미', 'knee,spine', 2, 3],
  ['박준호', 'spine', 2, 1],
  ['최선영', 'knee', 2, 2],
  ['정수민', 'knee,spine', 2, 3],
  ['한지훈', 'spine', 1, 1],
  ['조현우', 'knee', 3, 2],
  ['윤상미', 'knee,spine,cervical', 2, 4],
  ['강민석', 'spine', 2, 1],
  ['오진아', 'knee', 2, 2],
  ['박경훈', 'knee', 1, 2],
  ['신다은', 'knee,spine,cervical', 1, 4],
  ['임효진', 'spine', 3, 1],
  ['유동현', 'knee', 2, 2],
  ['문형준', 'knee,spine,cervical', 3, 4],
  ['송은지', 'spine,cervical', 2, 2],
  ['서지연', 'shoulder', 2, 2],
  ['장민호', 'shoulder', 2, 2],
  ['노유진', 'knee,shoulder', 3, 4],
  ['백승현', 'shoulder,spine', 2, 3],
  ['하은서', 'shoulder', 1, 2],
  ['안수진', 'wrist', 2, 1],
  ['구태훈', 'wrist,shoulder', 2, 3],
  ['진서영', 'wrist,spine,cervical', 3, 3],
  ['마현준', 'wrist', 3, 1],
  ['테스트환자26', 'cervical', 1, 1],
  ['테스트환자27', 'shoulder,cervical', 2, 3],
];
// 전체 출력(JSON.stringify) SHA-256 — 고정 시계·난수·UUID(goldenEnv) 아래에서.
const EXPECTED_HASH = '6daea6ef97dfbd2167b521b33e7e143b1e2e8ad9e1c56572c41e522d1789674e';

let createTestPatients;

beforeEach(async () => {
  useGoldenEnvironment();
  ({ createTestPatients } = await import('../createTestPatients'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createTestPatients() 출력 고정', () => {
  it('환자 수·환자별 요약·전체 해시', () => {
    const patients = createTestPatients();
    const summary = patients.map(p => [
      p.data.shared.name,
      p.data.activeModules.join(','),
      (p.data.shared.jobs || []).length,
      (p.data.shared.diagnoses || []).length,
    ]);
    const hash = createHash('sha256').update(JSON.stringify(patients)).digest('hex');
    expect(patients).toHaveLength(EXPECTED_COUNT);
    expect(summary).toEqual(EXPECTED_SUMMARY);
    expect(hash).toBe(EXPECTED_HASH);
  });
});
