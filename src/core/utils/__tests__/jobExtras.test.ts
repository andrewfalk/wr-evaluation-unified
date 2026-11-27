// upsertJobExtra(P2-68b) — 무릎·어깨 JobTab의 find-or-create를 옮긴 함수. 화면 쪽 결과는 twin-job-extras-*.json 골든이 고정한다.
import { describe, expect, it } from 'vitest';
import { upsertJobExtra } from '../jobExtras';

interface Extra { sharedJobId: string; a: string; b: string; extra?: string }
const factory = (sharedJobId: string): Extra => ({ sharedJobId, a: '', b: '' });

describe('upsertJobExtra', () => {
  it('있는 직력은 그 자리에서 { ...기존, ...patch } — 다른 항목·순서·팩토리 밖 필드는 그대로', () => {
    const extras: Extra[] = [{ sharedJobId: 'x', a: '1', b: '1' }, { sharedJobId: 'y', a: '2', b: '2', extra: '보존' }];
    const out = upsertJobExtra(extras, 'y', factory, { a: '9' });
    expect(out).toEqual([{ sharedJobId: 'x', a: '1', b: '1' }, { sharedJobId: 'y', a: '9', b: '2', extra: '보존' }]);
    expect(out[0]).toBe(extras[0]);
    expect(Object.keys(out[1])).toEqual(['sharedJobId', 'a', 'b', 'extra']);
  });

  it('없는 직력은 { ...factory(id), ...patch }를 끝에 붙인다(키 순서는 팩토리 순서)', () => {
    const out = upsertJobExtra<Extra>([], 'z', factory, { b: '5' });
    expect(out).toEqual([{ sharedJobId: 'z', a: '', b: '5' }]);
    expect(Object.keys(out[0])).toEqual(['sharedJobId', 'a', 'b']);
  });

  it('입력 배열은 고치지 않는다', () => {
    const extras: Extra[] = [{ sharedJobId: 'x', a: '1', b: '1' }];
    upsertJobExtra(extras, 'x', factory, { a: '2' });
    upsertJobExtra(extras, 'w', factory, { a: '3' });
    expect(extras).toEqual([{ sharedJobId: 'x', a: '1', b: '1' }]);
  });
});
