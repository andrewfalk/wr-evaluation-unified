// 관리자 콘솔(AdminConsoleModal) — EMR 감사 기록의 비고와 장치 목록의 "같은 PC" 묶음. 화면에 쓰는 순수 함수만 둔다.
// 표시의 뜻은 docs/AUDIT_LOG_ACTIONS.md("extra의 서버 표시").

export interface AuditItemLike {
  targetType?: string | null;
  extra?: unknown;
}

export interface EmrAuditNote {
  /** 설치본이 알린 EMR 동작 시각(서버가 확인한 것). 없으면 null — 행 시각은 서버 수신 시각이다. */
  occurredAt: string | null;
  /** 표시 문구(정해진 순서). */
  flags: string[];
}

// [extra 키, 표시 문구] — 화면에 보이는 순서.
export const EMR_AUDIT_FLAG_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['legacy_shell', '옛 설치본'],
  ['actor_uncertain', '행위자 불확실'],
  ['actor_unverified', '행위자 미검증'],
  ['burst', '몰아서 전송'],
  ['org_unresolved', '기관 미확정'],
];

/** EMR 기록(target_type 'emr')의 비고. 다른 기록이면 null. */
export function emrAuditNote(item: AuditItemLike): EmrAuditNote | null {
  if (item.targetType !== 'emr') return null;
  const extra = (item.extra && typeof item.extra === 'object' ? item.extra : {}) as Record<string, unknown>;
  const occurredAt = typeof extra.occurred_at === 'string' ? extra.occurred_at : null;
  const flags = EMR_AUDIT_FLAG_LABELS.filter(([key]) => extra[key] === true).map(([, label]) => label);
  return { occurredAt, flags };
}

export interface DeviceLike {
  keyPrefix?: string | null;
}

/** 지문 앞자리별 행 수 — 같은 PC(장치 키)에 등록된 행이 여럿이면 2 이상. */
export function devicesPerPc(devices: readonly DeviceLike[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const d of devices) {
    if (!d.keyPrefix) continue;
    counts.set(d.keyPrefix, (counts.get(d.keyPrefix) ?? 0) + 1);
  }
  return counts;
}

const DEVICE_ACTION_ERRORS: Record<string, string> = {
  DEVICE_PC_REVOKED: '이 PC는 해지되어 다시 승인할 수 없습니다. 그 PC에서 장치 키를 새로 만들어 등록해야 합니다.',
  DEVICE_ALREADY_REVOKED: '이미 해지된 PC입니다.',
  DEVICE_NOT_PENDING: '승인 대기 중인 행이 아닙니다.',
};

/** 장치 승인·해지 실패의 화면 문구(서버 오류 코드별, 모르는 코드는 서버 메시지). */
export function deviceActionErrorMessage(err: { message?: string; data?: unknown } | null | undefined): string {
  const data = err?.data as { code?: unknown } | null | undefined;
  const code = typeof data?.code === 'string' ? data.code : undefined;
  return (code && DEVICE_ACTION_ERRORS[code]) || err?.message || '요청에 실패했습니다.';
}
