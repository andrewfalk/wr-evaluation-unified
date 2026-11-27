// 팔꿈치·손목 데이터 config(P2-69b) — 공용 팩토리에 넘기는 값의 **모양**이 두 모듈에서 같아야 한다(한쪽에만 키를 더하면
// 다른 쪽이 조용히 기본 동작으로 돈다). 값 자체(필드 순서·상수 표·추론 규칙)는 모듈마다 다르고, 그 결과는
// src/modules/__tests__/__goldens__/twin-data-*.json(P2-67a)이 고정한다.
import { describe, expect, it } from 'vitest';
import { elbowDataConfig } from '../../../elbow/utils/dataConfig';
import { wristDataConfig } from '../../../wrist/utils/dataConfig';

const CONFIGS = [['elbow', elbowDataConfig], ['wrist', wristDataConfig]] as const;

describe('팔꿈치·손목 데이터 config', () => {
  it('두 config의 키 집합과 값의 종류가 같다', () => {
    const shape = (config: object) => Object.entries(config).map(([key, v]) => [key, Array.isArray(v) ? 'array' : typeof v]).sort();
    expect(shape(elbowDataConfig)).toEqual(shape(wristDataConfig));
  });

  it.each(CONFIGS)('%s: 엔트리 필드는 겹치지 않고, 메타 필드를 다시 적지 않으며, 분기 필드는 모두 엔트리 필드다(공구 압박 근거에는 옛 데이터에만 있는 bk2106_* 필드도 있어 검사하지 않는다)', (_id, config) => {
    const fields = config.entryFields.map(([field]) => field);
    expect(new Set(fields).size).toBe(fields.length);
    for (const meta of ['diagnosisId', 'selectedBkType', 'bkSelectionMode', 'bkAutoSyncedFrom']) expect(fields).not.toContain(meta);
    for (const branch of Object.values(config.branchFields).flat()) expect(fields).toContain(branch);
  });
});
