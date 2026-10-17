// AI 비식별 계약(shared/contracts/aiAnalysis·aiPrompt)의 열거형 키·한글 라벨이 모듈 원본 상수와 어긋나지 않는지.
// 계약은 shared 패키지라 analytics-core·모듈 data.js를 import하지 않는다(의존 방향) — 그래서 두 쪽을 모두 볼 수 있는 이 위치에서 묶는다.
// 원본이 바뀌면(키 추가·문구 수정) 여기서 실패하므로 계약(키 목록·라벨 사전)을 함께 고쳐야 한다.
import { describe, it, expect } from 'vitest';
import {
  SPINE_POSTURES, SHOULDER_EXPOSURE_KEYS, ELBOW_FLAG_KEYS, WRIST_FLAG_KEYS, CERVICAL_FLAG_KEYS,
  KNEE_AUX_KEYS, LOW_REASON_KEYS, KLG_VALUES, ELLMAN_VALUES, ELBOW_BK_TYPES, WRIST_BK_TYPES,
} from '../../../../shared/contracts/aiAnalysis';
import {
  SPINE_POSTURE_LABELS, SHOULDER_LABELS, ELBOW_FLAG_LABELS, WRIST_FLAG_LABELS, CERVICAL_FLAG_LABELS,
  KNEE_AUX_LABELS, LOW_REASON_LABELS, UNIFIED_AI_SYSTEM_PROMPT,
} from '../../../../shared/contracts/aiPrompt';
import { formulaDB, POSTURE_CODES, thresholds, vibrationThresholds } from '../../../../packages/analytics-core/modules/spine/constants';
import { EXPOSURE_LIMITS } from '../../../../packages/analytics-core/modules/shoulder/derived';
import { FLAG_META as ELBOW_FLAG_META } from '../../../../packages/analytics-core/modules/elbow/derived';
import { FLAG_META as WRIST_FLAG_META } from '../../../../packages/analytics-core/modules/wrist/derived';
import { FLAG_META as CERVICAL_FLAG_META } from '../../../../packages/analytics-core/modules/cervical/derived';
import { AUX_LABELS, KLG_OPTIONS, LOW_REASON_OPTIONS as KNEE_REASONS } from '../../../modules/knee/utils/data';
import { ELLMAN_OPTIONS, LOW_REASON_OPTIONS as SHOULDER_REASONS } from '../../../modules/shoulder/utils/data';
import { BK_TYPE_LABELS as ELBOW_BK_LABELS } from '../../../modules/elbow/utils/data';
import { BK_TYPE_LABELS as WRIST_BK_LABELS } from '../../../modules/wrist/utils/data';

const sorted = (values) => [...values].sort();
const nonEmpty = (options) => options.map((o) => o.value).filter(Boolean);

describe('AI 계약 키·라벨 ↔ 모듈 원본 드리프트', () => {
  it('척추 자세 G1~G11: 코드와 라벨(formulaDB[*].name)이 같다', () => {
    expect(sorted(SPINE_POSTURES)).toEqual(sorted(POSTURE_CODES));
    for (const code of POSTURE_CODES) expect(SPINE_POSTURE_LABELS[code], code).toBe(formulaDB[code].name);
  });

  it('어깨 노출 5항목: 키와 라벨(EXPOSURE_LIMITS[*].label)이 같다', () => {
    expect(sorted(SHOULDER_EXPOSURE_KEYS)).toEqual(sorted(Object.keys(EXPOSURE_LIMITS)));
    for (const key of Object.keys(EXPOSURE_LIMITS)) expect(SHOULDER_LABELS[key], key).toBe(EXPOSURE_LIMITS[key].label);
  });

  it.each([
    ['팔꿈치', ELBOW_FLAG_KEYS, ELBOW_FLAG_LABELS, ELBOW_FLAG_META],
    ['손목', WRIST_FLAG_KEYS, WRIST_FLAG_LABELS, WRIST_FLAG_META],
    ['경추', CERVICAL_FLAG_KEYS, CERVICAL_FLAG_LABELS, CERVICAL_FLAG_META],
  ])('%s 위험요인: 키와 라벨(FLAG_META[*].label)이 같다', (_name, keys, labels, meta) => {
    expect(sorted(keys)).toEqual(sorted(Object.keys(meta)));
    for (const key of Object.keys(meta)) expect(labels[key], key).toBe(meta[key].label);
  });

  it('무릎 보조변수: 키와 라벨(AUX_LABELS)이 같다', () => {
    expect(sorted(KNEE_AUX_KEYS)).toEqual(sorted(Object.keys(AUX_LABELS)));
    for (const key of Object.keys(AUX_LABELS)) expect(KNEE_AUX_LABELS[key], key).toBe(AUX_LABELS[key]);
  });

  it('업무관련성 낮음 사유: 키와 라벨이 무릎·어깨 옵션과 같다', () => {
    for (const options of [KNEE_REASONS, SHOULDER_REASONS]) {
      expect(sorted(LOW_REASON_KEYS)).toEqual(sorted(nonEmpty(options)));
      for (const option of options) expect(LOW_REASON_LABELS[option.value], option.value).toBe(option.label);
    }
  });

  it('K-L 등급·Ellman 값이 화면 옵션과 같다', () => {
    expect(sorted(KLG_VALUES)).toEqual(sorted(nonEmpty(KLG_OPTIONS)));
    expect(sorted(ELLMAN_VALUES)).toEqual(sorted(nonEmpty(ELLMAN_OPTIONS)));
  });

  it('팔꿈치·손목 BK 유형 목록이 모듈 옵션과 같다', () => {
    expect(sorted(ELBOW_BK_TYPES)).toEqual(sorted(Object.keys(ELBOW_BK_LABELS)));
    expect(sorted(WRIST_BK_TYPES)).toEqual(sorted(Object.keys(WRIST_BK_LABELS)));
  });

  it('시스템 프롬프트에 적힌 척추 기준값이 계산 상수와 같다', () => {
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain(`남 ${thresholds.lifetimeDose.court.male} MN·h, 여 ${thresholds.lifetimeDose.court.female} MN·h`);
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain(`Amax(8)≥${vibrationThresholds.dailyAmax}`);
    expect(UNIFIED_AI_SYSTEM_PROMPT).toContain(`DV,RI=${vibrationThresholds.lifetimeDV}`);
  });
});
