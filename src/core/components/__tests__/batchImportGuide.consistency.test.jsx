// @vitest-environment jsdom
//
// 일괄 가져오기 안내 목록 일치 테스트(P2-57, Phase 2 C6 — 사용자 결정 3: 안내 목록 코드는 그대로 두고 일치만 확인한다).
// ① 모달이 보여 주는 "지원 컬럼" 목록(IMPORT_FIELD_GROUPS — 화면에서 읽는다)이 가져오기 파서의 키(BASE_COLUMNS + 6모듈
//    batchImportConfig.columns)와 1:1로 대응하는지 — 표시 글자는 달라도(대소문자·별칭) 파서가 같은 규칙(normalizeHeader +
//    buildColMap)으로 인식해야 한다. ② 일괄 내보내기 머리글 124개가 전부 파서에 인식되는지. ③ 내보내기에 없는 가져오기 열(알려진 차이 —
//    결함 후보 2, 팔꿈치 8개)을 그대로 적어 둔다(고치면 이 목록을 바꾼다).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/elbow';
import '../../../modules/wrist';
import '../../../modules/spine';
import '../../../modules/cervical';
import { getAllModules } from '../../moduleRegistry';
import { BASE_COLUMNS, buildColMap, normalizeHeader } from '../../utils/batchImportHelpers';
import { getBatchHeaders } from '../../utils/exportService';
import { BatchImportModal } from '../BatchImportModal';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

afterEach(cleanup);

function parserGroups() {
  return [BASE_COLUMNS, ...getAllModules().map(mod => mod.batchImportConfig.columns)];
}

function parserKeys() {
  return parserGroups().flatMap(group => Object.keys(group));
}

function guideLabels() {
  const { container } = render(<BatchImportModal onClose={() => {}} onImport={() => {}} existingPatients={[]} />);
  return [...container.querySelectorAll('.import-reference-list li')].map(li => li.textContent);
}

describe('일괄 가져오기 안내 목록 ↔ 파서', () => {
  it('안내 목록 132개와 파서 키 132개가 1:1로 대응한다', () => {
    const labels = guideLabels();
    const keys = parserKeys();
    expect(labels).toHaveLength(132);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(132);

    const colMap = buildColMap(labels.map(normalizeHeader), parserGroups());
    const unmatchedKeys = keys.filter(key => colMap[key] === -1);
    const claimed = new Set(keys.map(key => colMap[key]));
    const unclaimedLabels = labels.filter((_, index) => !claimed.has(index));
    expect(unmatchedKeys).toEqual([]);
    expect(unclaimedLabels).toEqual([]);
  });

  it('일괄 내보내기 머리글 124개는 전부 파서가 인식한다', () => {
    const headers = getBatchHeaders();
    expect(headers).toHaveLength(124);
    const colMap = buildColMap(headers.map(normalizeHeader), parserGroups());
    const claimed = new Set(Object.values(colMap));
    expect(headers.filter((_, index) => !claimed.has(index))).toEqual([]);
  });

  it('내보내기에 없는 가져오기 열(알려진 차이 — 결함 후보 2)', () => {
    const colMap = buildColMap(getBatchHeaders().map(normalizeHeader), parserGroups());
    expect(parserKeys().filter(key => colMap[key] === -1)).toEqual([
      'elbowBk2105RepeatedFrictionImpact',
      'elbowBk2106RepeatedMechanicalExposure',
      'elbowBk2106NoncorrectablePosture',
      'elbowBk2106ProlongedJointPosition',
      'elbowBk2106ToolPressing',
      'elbowBk2106FrequentHighForceGrip',
      'elbowBk2103HandheldOrGuided',
      'elbowBk2103FrequentHighForceGrip',
    ]);
  });
});
