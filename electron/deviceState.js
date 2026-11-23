'use strict';
// electron/deviceState.js
// 이 PC(Windows 사용자 프로필)의 EMR 장치 승인 상태 — 등록 응답 해석, 상태 전이, EMR 게이트, 등록 요청 시점.
// electron 모듈을 require하지 않는다(단위 테스트 대상). 연결부는 audit.js.
//
// wr-device.json의 기존 필드(deviceId·publicKeyB64·status)는 의미를 바꾸지 않는다. status는 "프로필 전체의 상태"로,
// 새 서버의 응답을 한 번도 받지 못한 동안(교체 직후, 서버를 이전 버전으로 되돌린 동안) 게이트가 이 값을 쓴다 —
// 지금 설치본과 같은 방식이다. 새 서버(등록 응답에 deviceScope: 'pc')의 응답은 새 필드 pc에만 저장한다:
//   pc = { orgId, status: 'active' | 'pending' | 'revoked' | 'other_org', checkedAt }
// pc가 생긴 뒤에는 게이트가 "pc.status가 active이고 지금 로그인한 기관이 pc.orgId와 같을 때"만 열린다.

const DEVICE_SCOPE_PC = 'pc';
const PC_STATUSES = new Set(['active', 'pending', 'revoked']);

// 서버의 등록 제한: IP당 분당 1회, 사용자당 시간당 5회(server/src/middleware/rateLimit.ts).
const REGISTER_MIN_SPACING_MS = 61 * 1000;
const REGISTER_MAX_PER_HOUR = 5;
// 승인 대기 중인 PC의 재확인 간격(지금과 같다).
const PENDING_RECHECK_MS = 20 * 60 * 1000;

/**
 * 등록 요청의 결과를 해석한다. result = { ok: true, status, data } 또는 { ok: false, err }(err.status·err.code·err.body).
 * @returns {{ kind: 'pc', orgId: string | null, status: string }
 *   | { kind: 'legacy', status: 'active' | 'pending' }
 *   | { kind: 'retry_later' } | { kind: 'password_change' } | { kind: 'failed' }}
 */
function interpretRegisterResult(result) {
  if (result.ok) {
    const data = result.data;
    if (data?.deviceScope === DEVICE_SCOPE_PC && PC_STATUSES.has(data.status) && 'organizationId' in data) {
      return { kind: 'pc', orgId: data.organizationId ?? null, status: data.status };
    }
    if (data?.deviceScope === DEVICE_SCOPE_PC) return { kind: 'failed' }; // 알 수 없는 형식 — 아무것도 바꾸지 않는다
    return { kind: 'legacy', status: data?.status === 'active' ? 'active' : 'pending' };
  }
  const err = result.err ?? {};
  if (err.status === 409 && err.body?.deviceScope === DEVICE_SCOPE_PC && err.body?.status === 'other_org' && 'organizationId' in err.body) {
    return { kind: 'pc', orgId: err.body.organizationId ?? null, status: 'other_org' };
  }
  if (err.status === 429) return { kind: 'retry_later' };
  if (err.status === 403 && err.code === 'PASSWORD_CHANGE_REQUIRED') return { kind: 'password_change' };
  return { kind: 'failed' };
}

/**
 * 해석한 결과를 저장된 메타에 반영한 새 메타(바뀌지 않으면 같은 객체).
 * - 새 서버 응답: pc를 그대로 덮어쓴다(active·pending·revoked·other_org). active면 프로필 상태도 active로 올린다
 *   (이전 설치본으로 되돌려도 같은 동작).
 * - 이전 서버 응답: 프로필 상태를 active로 올릴 수는 있어도 내리지 않는다. pc는 건드리지 않는다.
 * - 실패(통신·서버 오류·429 등): 아무것도 바꾸지 않는다.
 */
function applyRegisterOutcome(meta, outcome, nowMs) {
  if (outcome.kind === 'pc') {
    return {
      ...meta,
      ...(outcome.status === 'active' ? { status: 'active' } : {}),
      pc: { orgId: outcome.orgId, status: outcome.status, checkedAt: new Date(nowMs).toISOString() },
    };
  }
  if (outcome.kind === 'legacy') {
    if (outcome.status === 'active' && meta.status !== 'active') return { ...meta, status: 'active' };
    if (outcome.status === 'pending' && meta.status !== 'active' && meta.status !== 'pending') return { ...meta, status: 'pending' };
    return meta;
  }
  return meta;
}

/** pc 필드가 형식에 맞는가(손으로 고친 파일·이전 형식은 없는 것으로 본다). */
function validPc(pc) {
  return Boolean(pc) && typeof pc === 'object'
    && (pc.orgId === null || typeof pc.orgId === 'string')
    && (PC_STATUSES.has(pc.status) || pc.status === 'other_org');
}

/**
 * EMR 게이트. login = { userId, orgId } | null(토큰 없음), memoryStatus = 이번 실행의 프로필 상태('error' 포함).
 * @returns {{ allowed: boolean, reason: 'ok' | 'pending' | 'revoked' | 'other_org' | 'org_unconfirmed' | 'unregistered' }}
 */
function emrGateDecision(meta, login, memoryStatus) {
  if (meta && validPc(meta.pc)) {
    const pc = meta.pc;
    if (!login || login.orgId === undefined) return { allowed: false, reason: 'org_unconfirmed' };
    if (pc.orgId !== login.orgId) return { allowed: false, reason: 'org_unconfirmed' };
    if (pc.status === 'active') return { allowed: true, reason: 'ok' };
    return { allowed: false, reason: pc.status };
  }
  if (memoryStatus === 'active') return { allowed: true, reason: 'ok' };
  if (memoryStatus === 'pending') return { allowed: false, reason: 'pending' };
  return { allowed: false, reason: 'unregistered' };
}

/** 대기열·즉시 전송을 해도 되는가: 새 서버의 응답을 받은 뒤에는 그 PC가 active일 때, 그 전에는 프로필 상태가 active일 때. */
function sendingAllowed(meta, memoryStatus) {
  if (meta && validPc(meta.pc)) return meta.pc.status === 'active';
  return memoryStatus === 'active';
}

/**
 * 지금 등록 API를 불러야 하는가. 서버 제한을 넘지 않도록 마지막 호출에서 61초, 최근 1시간 5회를 지킨다.
 * state = { meta, login, startedFresh (이번 실행에서 아직 새 서버 응답 확인 전), deviceProblem (감사 전송이 장치 문제 401),
 *           attempts: number[] (이번 실행의 등록 호출 시각) }
 * @returns {{ register: boolean, reason?: string }}
 */
function shouldRegister(state, nowMs) {
  const { meta, login, attempts } = state;
  if (!login) return { register: false };
  const recent = attempts.filter((t) => nowMs - t < 60 * 60 * 1000);
  const last = attempts.length ? Math.max(...attempts) : -Infinity;
  const budget = nowMs - last >= REGISTER_MIN_SPACING_MS && recent.length < REGISTER_MAX_PER_HOUR;
  let reason = null;
  const pc = meta && validPc(meta.pc) ? meta.pc : null;
  if (state.startedFresh) reason = 'first_token';
  else if (!pc) reason = meta?.status === 'active' ? null : 'not_active';
  else if (pc.orgId !== login.orgId) reason = 'org_changed';
  else if (state.deviceProblem) reason = 'device_problem';
  else if (pc.status === 'pending' && nowMs - last >= PENDING_RECHECK_MS) reason = 'pending_recheck';
  if (!reason) return { register: false };
  // 이전 서버(pc 없음)의 승인 대기는 지금처럼 20분 간격.
  if (reason === 'not_active' && nowMs - last < PENDING_RECHECK_MS && attempts.length > 0) return { register: false };
  return budget ? { register: true, reason } : { register: false, reason };
}

module.exports = {
  DEVICE_SCOPE_PC,
  REGISTER_MIN_SPACING_MS,
  REGISTER_MAX_PER_HOUR,
  PENDING_RECHECK_MS,
  interpretRegisterResult,
  applyRegisterOutcome,
  emrGateDecision,
  sendingAllowed,
  shouldRegister,
};
