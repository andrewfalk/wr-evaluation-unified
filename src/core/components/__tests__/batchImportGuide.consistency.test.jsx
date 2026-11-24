// @vitest-environment jsdom
//
// 일괄 가져오기 안내 목록 일치 테스트(P2-57, Phase 2 C6 → FX-2, Phase 2 C7-a에서 안내를 내보내기 머리글에 맞춤).
// ① 모달이 보여 주는 "지원 컬럼" 목록(IMPORT_FIELD_GROUPS — 화면에서 읽는다)은 전부 가져오기 파서의 키(BASE_COLUMNS + 6모듈
//    batchImportConfig.columns)에 대응하고, 안내에 없는 파서 키는 팔꿈치 옛 필드 6개뿐이다 — 화면에서 더 입력하지 않고 applyRow가
//    읽지 않는 필드라 안내에서 뺐다(사용자 결정 2026-11-24). 파서 키는 남겨 옛 파일이 오류 없이 읽힌다.
// ② 일괄 내보내기 머리글 124개는 전부 **정확 일치**(1단계)로 그 머리글을 후보에 가진 키에 배정된다 — 부분 일치에 기대지 않는다.
// ③ 내보내기에 없는 가져오기 열 = 팔꿈치 옛 필드 8개(무시 6 · 대체값 2 — 대체값 2개는 bk2103_tool_pressing에 들어간다).
//    옛 머리글이 든 파일이 그대로 읽히는지도 확인한다.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import '../../../modules/knee';
import '../../../modules/shoulder';
import '../../../modules/elbow';
import '../../../modules/wrist';
import '../../../modules/spine';
import '../../../modules/cervical';
import { getAllModules, getModule } from '../../moduleRegistry';
import { BASE_COLUMNS, buildColMap, getCell, normalizeHeader } from '../../utils/batchImportHelpers';
import { getBatchHeaders } from '../../utils/exportService';
import { BatchImportModal } from '../BatchImportModal';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ session: null }) }));

afterEach(cleanup);

/** 화면에서 더 입력하지 않고 applyRow가 읽지 않는 팔꿈치 옛 필드 — 안내에서 뺐다. */
const OLD_FIELDS_IGNORED = [
  'elbowBk2105RepeatedFrictionImpact',
  'elbowBk2106RepeatedMechanicalExposure',
  'elbowBk2106NoncorrectablePosture',
  'elbowBk2106ProlongedJointPosition',
  'elbowBk2106FrequentHighForceGrip',
  'elbowBk2103HandheldOrGuided',
];
/** 옛 필드 중 bk2103_tool_pressing의 대체값으로 읽는 2개 — 안내에 남긴다. */
const OLD_FIELDS_FALLBACK = ['elbowBk2106ToolPressing', 'elbowBk2103FrequentHighForceGrip'];

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
  it('안내 126개는 전부 파서 키에 대응하고, 안내에 없는 파서 키는 옛 필드 6개뿐이다', () => {
    const labels = guideLabels();
    const keys = parserKeys();
    expect(labels).toHaveLength(126);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toHaveLength(132);

    const colMap = buildColMap(labels.map(normalizeHeader), parserGroups());
    const claimed = new Set(keys.map(key => colMap[key]));
    expect(labels.filter((_, index) => !claimed.has(index))).toEqual([]);
    expect(keys.filter(key => colMap[key] === -1)).toEqual(OLD_FIELDS_IGNORED);
  });

  it('안내 개수 표시가 목록 개수와 같다', () => {
    const { container } = render(<BatchImportModal onClose={() => {}} onImport={() => {}} existingPatients={[]} />);
    expect(container.textContent).toContain('126개');
  });

  it('일괄 내보내기 머리글 124개는 전부 정확 일치로, 그 머리글을 후보에 가진 키에 배정된다', () => {
    const headers = getBatchHeaders();
    expect(headers).toHaveLength(124);
    const groups = parserGroups();
    const candidates = Object.assign({}, ...groups);
    const colMap = buildColMap(headers.map(normalizeHeader), groups);
    const assignedKeyByIndex = new Map(Object.entries(colMap).map(([key, index]) => [index, key]));
    const wrong = headers.flatMap((header, index) => {
      const owners = Object.keys(candidates).filter(key => candidates[key].includes(normalizeHeader(header)));
      const assigned = assignedKeyByIndex.get(index);
      return owners.length === 1 && owners[0] === assigned ? [] : [{ header, owners, assigned }];
    });
    expect(wrong).toEqual([]);
  });

  it('내보내기에 없는 가져오기 열 = 팔꿈치 옛 필드 8개(무시 6 · 대체값 2)', () => {
    const colMap = buildColMap(getBatchHeaders().map(normalizeHeader), parserGroups());
    expect(parserKeys().filter(key => colMap[key] === -1).sort()).toEqual([...OLD_FIELDS_IGNORED, ...OLD_FIELDS_FALLBACK].sort());
  });

  it('옛 머리글이 든 파일도 그대로 읽힌다 — 대체값 2개는 bk2103_tool_pressing으로, 무시 6개는 오류 없이 지나간다', () => {
    const headerRow = [
      '팔꿈치_BK유형', '팔꿈치_문제작업명',
      '팔꿈치_BK2105_반복마찰충격', '팔꿈치_BK2106_반복기계적부담', '팔꿈치_BK2106_강제자세', '팔꿈치_BK2106_관절자세유지',
      '팔꿈치_BK2106_고힘그립', '팔꿈치_BK2103_손유도공구',
      '팔꿈치_BK2106_공구압박',
    ].map(normalizeHeader);
    const colMap = buildColMap(headerRow, parserGroups());
    const elbow = getModule('elbow').batchImportConfig;
    const run = (row) => {
      const patient = { id: 'p', data: { shared: { diagnoses: [], jobs: [] }, modules: {}, activeModules: [] } };
      const diagnosis = { id: 'd1', code: 'M77.1', name: '외측상과염', side: 'right' };
      const job = { id: 'j1', jobName: '조립공' };
      elbow.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex: 1 });
      return patient.data.modules.elbow.jobEvaluations[0].diagnosisEntries[0];
    };

    const entry = run(['BK2101', '체결', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes']);
    expect(entry.selectedBkType).toBe('BK2101');
    expect(entry.bk2103_tool_pressing).toBe('yes');
    for (const field of [
      'bk2105_repeated_friction_impact', 'bk2106_repeated_mechanical_exposure', 'bk2106_noncorrectable_posture',
      'bk2106_prolonged_joint_position', 'bk2106_frequent_high_force_grip', 'bk2103_handheld_or_guided',
    ]) {
      expect(entry[field] ?? '', field).toBe('');
    }

    // 두 번째 대체값(BK2103 고힘그립)만 있어도 bk2103_tool_pressing에 들어간다.
    const onlyGrip = buildColMap(['팔꿈치_bk유형', '팔꿈치_bk2103_고힘그립'], parserGroups());
    const patient = { id: 'p2', data: { shared: { diagnoses: [], jobs: [] }, modules: {}, activeModules: [] } };
    elbow.applyRow({
      patient, row: ['BK2103', 'no'], diagnosis: { id: 'd2', code: 'M77.0', side: 'left' }, job: { id: 'j2' },
      colMap: onlyGrip, getCell, rowIndex: 2,
    });
    expect(patient.data.modules.elbow.jobEvaluations[0].diagnosisEntries[0].bk2103_tool_pressing).toBe('no');
  });
});
