// EMR b6·b8 모듈 순서(P2-63) — 등록 순서와 무관하게 narrative.emrOrder로 정한다.
import { describe, expect, it } from 'vitest';
import '../../../modules';
import type { ModuleManifest } from '../../modules/manifest';
import { getAllModules } from '../../modules/registry';
import { getEmrNarrativeModules, sortByEmrOrder } from '../emrOrder';

const fake = (id: string, emrOrder?: number) => ({
  id,
  ...(emrOrder === undefined ? {} : { narrative: { emrOrder, render: () => '' } }),
}) as unknown as ModuleManifest;

describe('EMR 모듈 순서', () => {
  it('6개 모듈의 EMR 순서는 무릎·어깨·손목·팔꿈치·경추·척추다(등록 순서와 다르다)', () => {
    expect(getAllModules().map(m => m.id)).toEqual(['knee', 'spine', 'cervical', 'shoulder', 'elbow', 'wrist']);
    expect(getEmrNarrativeModules().map(m => m.id)).toEqual(['knee', 'shoulder', 'wrist', 'elbow', 'cervical', 'spine']);
  });

  it('서술이 없는 모듈은 빠지고, 입력 순서와 무관하게 emrOrder로 정렬한다', () => {
    const input = [fake('c', 30), fake('none'), fake('a', 10), fake('b', 20)];
    expect(sortByEmrOrder(input).map(m => m.id)).toEqual(['a', 'b', 'c']);
    expect(input.map(m => m.id)).toEqual(['c', 'none', 'a', 'b']);
  });

  it('같은 emrOrder가 둘이면 throw한다', () => {
    expect(() => sortByEmrOrder([fake('a', 10), fake('b', 10)])).toThrow("emrOrder 10이 'a'와 'b'에 겹칩니다");
  });
});
