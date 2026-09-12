import { describe, it, expect } from 'vitest';
import { resolveLevelOrder } from '../statsBivariateRoles';

describe('resolveLevelOrder', () => {
  it('boolean은 항상 [false, true]', () => {
    expect(resolveLevelOrder('boolean', 'anything')).toEqual([false, true]);
  });

  it('ordinal은 카탈로그 선언 순서를 그대로 쓴다', () => {
    expect(resolveLevelOrder('ordinal', 'knee.diagnosisSide.klGrade')).not.toBeNull();
  });

  it('ordinal인데 선언된 순서가 없으면 null', () => {
    expect(resolveLevelOrder('ordinal', 'not.a.real.ordinal.key')).toBeNull();
  });

  it('categorical — 고정 순서가 선언된 변수(신청상병 부위군)는 observedValues 없이도 그 순서를 쓴다', () => {
    const order = resolveLevelOrder('categorical', 'diagnosis.identity.moduleGroup');
    expect(order).toEqual(['knee', 'wrist', 'elbow', 'shoulder', 'spine', 'cervical']);
  });

  // 2026-09-12 리뷰 재현 — 이전 판은 categorical에 항상 null을 반환해 담당의처럼 값
  // 집합이 조직 데이터마다 달라지는 변수의 그룹비교/분할표 분석이 전부 막혀 있었다.
  it('categorical — 고정 순서가 없는 변수(담당의)는 observedValues에서 동적으로 순서를 만든다', () => {
    const order = resolveLevelOrder('categorical', 'case.staff.assignedDoctorUserId', ['doctor-c', 'doctor-a', 'doctor-b', 'doctor-a']);
    expect(order).toEqual(['doctor-a', 'doctor-b', 'doctor-c']); // 중복 제거 + 결정적 정렬
  });

  it('categorical — 고정 순서도 없고 observedValues도 없으면 null(호출자가 방어)', () => {
    expect(resolveLevelOrder('categorical', 'case.staff.assignedDoctorUserId')).toBeNull();
  });

  it('categorical — observedValues가 빈 배열이면 빈 배열(관측 자체가 없다는 뜻, null과 다르다)', () => {
    expect(resolveLevelOrder('categorical', 'case.staff.assignedDoctorUserId', [])).toEqual([]);
  });

  it('결정성 — 동일 observedValues를 다른 순서로 넣어도 같은 order를 낸다', () => {
    const a = resolveLevelOrder('categorical', 'case.staff.assignedDoctorUserId', ['doctor-b', 'doctor-a']);
    const b = resolveLevelOrder('categorical', 'case.staff.assignedDoctorUserId', ['doctor-a', 'doctor-b']);
    expect(a).toEqual(b);
  });

  it('continuous/date/high_cardinality 등 그루핑 불가 타입은 null', () => {
    expect(resolveLevelOrder('continuous', 'x')).toBeNull();
    expect(resolveLevelOrder('date', 'case.meta.registeredAt')).toBeNull();
    expect(resolveLevelOrder('high_cardinality', 'job.identity.jobNameNormalized')).toBeNull();
  });
});
