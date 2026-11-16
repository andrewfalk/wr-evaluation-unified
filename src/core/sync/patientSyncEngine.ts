// 환자 동기화 엔진(REFACTORING_ROADMAP Phase 2 C4-2, 게이트 B 계획 설계 4, P2-41d) — React 없음.
//
// usePatientSync.js 본체를 옮긴 것이다(동작 변경 0 — P2-41c에서 스토어를 직접 읽게 바꾼 뒤 구조만 이동). 얇은 훅이 입력·트리거를
// 맡고, 엔진은 push·pull 사이클·flushPatient 대기만 다룬다.
// - 엔진은 **스토어를 구독하지 않고 타이머·리스너도 갖지 않는다**(계획 B6) — 시작·scope 변경·5분 주기·focus·1초 debounce·waiter
//   안전망은 전부 훅의 effect가 부른다. 구독으로 바꾸면 사이클 판정보다 안전망이 먼저 돌아 423 결과가 'lock-lost' → 'conflict'로
//   바뀐다.
// - 입력(session·settings·scope·lockState·enabled)은 훅이 지금과 같은 시점에 갱신하는 ref 객체를 getInputs()로 호출 시점에 읽는다
//   (계획 B8 — enabled는 렌더 중 대입 + effect 정리에서 false, 계정 전환 수정 AS-2 언마운트 가드).
// - 인스턴스는 훅 인스턴스(= 작업 공간 경계 아래 App)당 하나 — 모듈 싱글턴이면 계정이 바뀌어도 이전 계정의 큐가 살아남는다.
//   in-flight·큐는 StrictMode 이중 effect를 건너 유지된다(정지 시 진행 중 요청을 끊지 않음, 계획 B10).
// - JS 서비스는 같은 경로('../services/…')로 import하고 바인딩은 호출 시점에만 읽는다 — 훅 테스트가 서비스 모듈을 일부 export만
//   가진 vi.mock으로 바꿔 두면 최상위 접근은 모듈 로드를 실패시킨다(부분 vi.mock 함정).
import type { PatientRecord } from '../types/patient';
import type { PatientStore } from '../state/patientStore/store';
import { patientTx } from '../state/patientStore/transitions';
import {
  pullPatients as pullPatientsJs,
  pushPendingPatients as pushPendingPatientsJs,
  computeCommittedFlushOutcomes as computeCommittedFlushOutcomesJs,
} from '../services/patientServerRepository';
import { isRedactedPatientRecord as isRedactedPatientRecordJs } from '../services/patientRecords';
import { getLockToken as getLockTokenJs } from '../services/lockTokenStore';
import { sessionIdentityOf } from '../../platform/dataMode';

const PULL_PAGE_SIZE = 100;

export interface LockStateInput {
  status?: string;
  holder?: unknown;
  expiresAt?: unknown;
}

export interface SyncInputs {
  session: unknown;
  settings: unknown;
  scope: string;
  lockState: LockStateInput | null | undefined;
  /** canSync(동기화 가능) — 훅이 렌더 중 대입하고 effect 정리에서 false로(AS-2). */
  enabled: boolean;
}

export interface SyncState {
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
  serverUnassignedCount: number | null;
  serverPatientCount: number | null;
  loadedScope: string | null;
  lastPermissionDeniedCount?: number;
  lastPermissionDeniedAt?: string | null;
}

export interface RunSyncOptions {
  push?: boolean;
  pull?: boolean;
  reason?: string;
}

export type RunSyncResult = { ok: true; reason: string; lastSyncedAt: string } | { ok: false; reason: string; error: unknown } | null;

export type FlushOutcome = 'synced' | 'conflict' | 'lock-lost' | 'permission' | 'offline' | 'error' | 'still-dirty' | string;

export interface PushFailure {
  patient: PatientRecord;
  error: unknown;
  kind: string;
}
interface PushResult {
  synced: Array<{ patient: PatientRecord; serverPatient: PatientRecord }>;
  failed: PushFailure[];
}
interface PullPage {
  items?: PatientRecord[];
  total?: number;
  unassignedCount?: number;
  orgPatientCount?: number;
}

// --- JS 서비스 호출 시점 래퍼
function pullPatients(args: { session: unknown; settings: unknown; params: Record<string, unknown> }): Promise<PullPage> {
  return (pullPatientsJs as unknown as (a: typeof args) => Promise<PullPage>)(args);
}
function pushPendingPatients(patients: PatientRecord[], ctx: { session: unknown; settings: unknown }): Promise<PushResult> {
  return (pushPendingPatientsJs as unknown as (p: PatientRecord[], c: typeof ctx) => Promise<PushResult>)(patients, ctx);
}
function computeCommittedFlushOutcomes(patients: PatientRecord[], result: PushResult): Map<string, FlushOutcome> {
  return (computeCommittedFlushOutcomesJs as unknown as (p: PatientRecord[], r: PushResult) => Map<string, FlushOutcome>)(patients, result);
}
function isRedactedPatientRecord(patient: PatientRecord): boolean {
  return (isRedactedPatientRecordJs as unknown as (p: PatientRecord) => boolean)(patient);
}
function getLockToken(patientId: string): string | null | undefined {
  return (getLockTokenJs as unknown as (id: string) => string | null | undefined)(patientId);
}

type SyncMeta = { syncStatus?: string; syncPaused?: boolean } | undefined;
const syncOf = (p: PatientRecord | null | undefined): SyncMeta => (p as { sync?: SyncMeta } | null | undefined)?.sync;

export function hasPendingPatients(patients: PatientRecord[] = []): boolean {
  return patients.some(p => {
    if (isRedactedPatientRecord(p)) return false;
    if (syncOf(p)?.syncPaused) return false; // "저장하지 않고 이동" — 자동저장 대상에서 제외
    const status = syncOf(p)?.syncStatus;
    return status === 'local-only' || status === 'dirty';
  });
}

export interface PushEligibility {
  allowed: boolean;
  reason?: string;
}

// 활성 환자에 한해서만 락 상태를 근거로 push 허용 여부를 판정한다(비활성 dirty 환자는 항상
// allowed:true — opt-in 호환. 토큰이 없어도 서버가 그 환자에 활성 락이 없으면 통과시킨다).
//
// syncPaused는 activeId 여부와 무관하게 최우선으로 확인한다 — "저장하지 않고 이동"은 정확히
// 그 환자가 활성 상태가 아니게 된 시점에 거는 플래그라서, activeId 분기보다 뒤에 두면 비활성
// 환자에게는 이 게이트가 아예 적용되지 않는 버그가 된다.
//
// lockState.status === 'none'은 usePatientLock이 "이 환자는 애초에 락 대상이 아니다"라고
// 이미 판정한 결과(로컬 전용이거나 비인트라넷 세션)이므로, 여기서 다시 session/serverId를
// 확인하지 않고 그대로 신뢰한다.
export function getPushEligibility(
  patientId: string,
  { activeId, lockState, patient }: { activeId?: string | null; lockState?: LockStateInput | null; patient?: PatientRecord | null } = {},
): PushEligibility {
  if (syncOf(patient)?.syncPaused) return { allowed: false, reason: 'sync-paused' };
  if (patientId !== activeId) return { allowed: true };
  const status = lockState?.status;
  if (status === 'none') return { allowed: true };
  if (status === 'held') {
    // 'held'인데 레지스트리에 토큰이 아직 없는(레이스로 setLockToken 전인) 순간을 방어적으로
    // 걸러 토큰 없는 PATCH가 나가는 걸 막는다.
    return getLockToken(patientId) != null
      ? { allowed: true }
      : { allowed: false, reason: 'bootstrap-pending' };
  }
  if (status === 'held-by-other') return { allowed: false, reason: 'lock-held-by-other' };
  if (status === 'lost') return { allowed: false, reason: 'lock-lost' };
  return { allowed: false, reason: 'bootstrap-pending' }; // 'acquiring' 등 아직 결론 안 남
}

async function pullAllPatients({ session, settings, scope = 'mine' }: { session: unknown; settings: unknown; scope?: string }) {
  const all: PatientRecord[] = [];
  let offset = 0;
  let total: number | null = null;
  let unassignedCount: number | undefined;
  let orgPatientCount: number | undefined;

  do {
    const result = await pullPatients({
      session,
      settings,
      params: { limit: PULL_PAGE_SIZE, offset, scope },
    });
    const items = result.items || [];
    all.push(...items);
    total = typeof result.total === 'number' ? result.total : all.length;
    if (typeof result.unassignedCount === 'number') unassignedCount = result.unassignedCount;
    if (typeof result.orgPatientCount === 'number') orgPatientCount = result.orgPatientCount;
    offset += items.length;
    if (items.length === 0) break;
  } while (all.length < total);

  return { items: all, unassignedCount, orgPatientCount };
}

interface Waiter {
  resolve: (outcome: FlushOutcome) => void;
  targetCycleId: number;
}

export interface PatientSyncEngineDeps {
  store: PatientStore;
  getInputs: () => SyncInputs;
  setSyncState: (update: (prev: SyncState) => SyncState) => void;
}

export interface PatientSyncEngine {
  runSync(options?: RunSyncOptions): Promise<RunSyncResult>;
  flushPatient(patientId: string): Promise<FlushOutcome>;
  notifyLockOutcome(patientId: string, outcome: FlushOutcome): void;
  /** 안전망 — patients(렌더 값)에서 이미 결론이 난(synced/conflict) 환자의 waiter를 푼다(훅의 렌더 값 effect가 부른다). */
  settleWaiters(patients: PatientRecord[]): void;
  /** 진짜 종료(동기화 비활성화·언마운트) — 남은 waiter를 전부 'error'로 푼다. */
  disposeWaiters(): void;
  /**
   * 활성 환자의 syncPaused 해제("저장하지 않고 이동" 뒤 다시 열었을 때). 재개할 것이 없으면 dispatch하지 않는다(P2-41c — 같은 값
   * 갱신이 effect 밖에서 따로 렌더·커밋되지 않게). 훅이 effect 단계 뒤(마이크로태스크)에 부른다(계획 B7).
   */
  resumePatient(patientId: string, lockStatus: string | undefined, session: unknown): void;
}

export function createPatientSyncEngine({ store, getInputs, setSyncState }: PatientSyncEngineDeps): PatientSyncEngine {
  let inFlight = false;
  let queued: RunSyncOptions | null = null;
  let cycleCounter = 0;
  const flushWaiters = new Map<string, Waiter[]>(); // patientId -> [{ resolve, targetCycleId }]

  // 이번 push 사이클의 결과로 대기 중인 flushPatient를 확정한다. 판정은 store.dispatch(pushResultsApplied) 직후 같은 동기
  // 구간의 앞선 상태(= 서버 ACK가 병합된 목록)로 한다 — 옮기기 전 커밋 배리어(outcomeTick·pendingCommitRef)가 기다리던
  // "커밋 뒤"와 같은 목록이고, 판정과 병합 사이에 다른 쓰기가 끼어들 동기 구간이 없다(게이트 B 계획 설계 4 I1·I2).
  function settleCycleWaiters(cycleId: number, outcomes: Map<string, FlushOutcome>): void {
    for (const [patientId, waiters] of flushWaiters) {
      const outcome = outcomes.get(patientId);
      if (outcome === undefined) continue;
      const remaining = waiters.filter(w => {
        if (cycleId < w.targetCycleId) return true; // 아직 내 목표 cycle 전 — 계속 대기
        w.resolve(outcome);
        return false;
      });
      if (remaining.length > 0) flushWaiters.set(patientId, remaining);
      else flushWaiters.delete(patientId);
    }
  }

  async function runSync({ push = false, pull = false, reason = 'manual' }: RunSyncOptions = {}): Promise<RunSyncResult> {
    if (!getInputs().enabled) return null;

    if (inFlight) {
      queued = {
        push: Boolean(queued?.push || push),
        pull: Boolean(queued?.pull || pull),
        reason,
      };
      return null;
    }

    inFlight = true;
    setSyncState(prev => ({ ...prev, status: 'syncing', lastError: null }));

    // 이번 sync에서 발생한 permission failure 수. push가 실제 발생하지 않으면 0 유지.
    // 종료부에서 lastSyncedAt setState와 함께 한 번에 반영해 push-only/pull-only/both 모두 일관 처리.
    let permissionDeniedCount = 0;

    try {
      if (push) {
        // 앞선 상태(store) — 앞서 dispatch된 편집·ACK 병합이 전부 반영된 목록(커밋을 기다리지 않는다, P2-41c).
        const { patients: snapshot, activeId: snapshotActiveId } = store.getState();
        if (hasPendingPatients(snapshot)) {
          // 환자마다 개별 판정한다 — 활성 환자는 락 상태로, 비활성 환자는 opt-in 그대로
          // 허용하되 syncPaused("저장하지 않고 이동")만은 활성 여부와 무관하게 제외한다.
          const pushTargets = snapshot.filter(p => getPushEligibility(p.id, {
            activeId: snapshotActiveId || null,
            lockState: getInputs().lockState,
            patient: p,
          }).allowed);

          // 보낼 게 아예 없으면(예: 유일한 dirty 환자가 게이트로 제외됨) 네트워크 호출 자체를
          // 생략한다(사이클 번호도 소모하지 않음).
          if (pushTargets.length > 0) {
            const myCycleId = ++cycleCounter;
            const { session, settings } = getInputs();
            // push를 보낸 세션의 식별(서버 주소 + 계정 + 조직 — 계정 전환 수정의 요청 신원과 같은 키).
            const pushIdentity = sessionIdentityOf(session as Parameters<typeof sessionIdentityOf>[0]);
            const { synced, failed } = await pushPendingPatients(pushTargets, { session, settings });

            if (!getInputs().enabled) {
              // (flagged P2-43a, D1) 응답을 기다리는 동안 동기화가 꺼졌다. 서버는 이미 저장했으므로 같은 세션이면 ACK를
              // **목록에 남아 있는 환자에만** 반영한다 — 버리면 로컬은 옛 revision이라 다시 켰을 때 409 충돌로 표시된다(내용이
              // 같아도). 세션(서버·계정·조직)이 바뀌었으면 옮기기 전처럼 버린다. pull은 하지 않고 idle로 끝낸다.
              const sameSession = pushIdentity !== null
                && pushIdentity === sessionIdentityOf(getInputs().session as Parameters<typeof sessionIdentityOf>[0]);
              if (sameSession && (synced.length > 0 || failed.length > 0)) {
                if (synced.length > 0 || failed.some(f => f.kind === 'conflict' || f.kind === 'lock')) {
                  store.dispatch(patientTx.pushAckSettled({ synced, failed }));
                }
                settleCycleWaiters(myCycleId, computeCommittedFlushOutcomes(store.getState().patients, { synced, failed }));
              }
              setSyncState(prev => ({ ...prev, status: 'idle' }));
              return null;
            }

            if (synced.length > 0 || failed.length > 0) {
              if (synced.length > 0 || failed.some(f => f.kind === 'conflict' || f.kind === 'lock')) {
                store.dispatch(patientTx.pushResultsApplied({ synced, failed }));
              }
              // dispatch가 돌아온 지금 앞선 상태는 ACK가 병합된 목록이다 — 같은 동기 구간에서 flushPatient 대기를 확정한다.
              // 큐에 있던 다음 사이클도 이 목록에서 스냅샷을 뜨므로 방금 성공한 것을 옛 revision으로 재전송(가짜 409)하지 않는다.
              settleCycleWaiters(myCycleId, computeCommittedFlushOutcomes(store.getState().patients, { synced, failed }));
            }

            permissionDeniedCount = failed.filter(f => f.kind === 'permission').length;
            if (permissionDeniedCount > 0) {
              console.warn(`[sync] ${permissionDeniedCount}건의 환자가 권한 없음으로 동기화되지 않았습니다.`);
            }

            // conflict/permission/lock 외 진짜 에러만 throw → 일반 실패 알림 흐름.
            // lock은 conflict와 동일하게 patient.sync에 이미 반영했으므로(위) 별도로 던지지 않는다.
            const realFailure = failed.find(f => !['conflict', 'permission', 'lock'].includes(f.kind));
            if (realFailure) throw realFailure.error;
          }
        }
      }

      let serverUnassignedCount: number | undefined;
      let serverPatientCount: number | undefined;
      let appliedScope: string | undefined; // pull 결과가 실제로 `patients`에 반영된 스코프 (stale이면 미반영)
      if (pull) {
        const { session, settings, scope: pulledScope } = getInputs();
        const { items: pulledItems, unassignedCount, orgPatientCount } = await pullAllPatients({ session, settings, scope: pulledScope });
        if (typeof unassignedCount === 'number') serverUnassignedCount = unassignedCount;
        if (typeof orgPatientCount === 'number') serverPatientCount = orgPatientCount;
        if (!getInputs().enabled) {
          setSyncState(prev => ({ ...prev, status: 'idle' }));
          return null;
        }
        // Stale-pull 가드: pull 진행 중 스코프가 바뀌었으면(A→B) A 결과를 B 기준으로
        // 적용하지 않는다. 특히 좁은 pull(mine/doctor-id)이 all 화면의 synced 환자를
        // out-of-scope로 축출하는 사고를 막는다. 스코프 변경 시 queued sync가
        // 현재 스코프로 재-pull하므로 skip해도 안전하다.
        // authoritativeDeletes도 live scope가 아니라 pulledScope로 판정(방어).
        if (pulledScope === getInputs().scope) {
          appliedScope = pulledScope;
          // 활성 환자 폴백(비어 있다가 채워지면 첫 환자 / 활성 환자가 결과에 없으면 첫 환자·null)은 전이의 derive가 같은
          // 적용 안에서 정한다(P2-41c — 옮기기 전 updater 안 queueMicrotask 예약을 대체). 스텝은 옮기기 전처럼 건드리지 않는다.
          store.dispatch(patientTx.pullApplied({
            pulledItems,
            authoritativeDeletes: pulledScope === 'all',
          }));
        }
      }

      const lastSyncedAt = new Date().toISOString();
      // 권한 거부 배너 통합 처리: push/pull 어느 쪽이든 성공 종료 시 stale 정리.
      // - permission failure 있었음 → count/timestamp 갱신
      // - 없거나 push가 안 일어남 → 이전에 남아있던 카운트를 0으로 clear (pull-only sync 포함)
      setSyncState(prev => ({
        ...prev,
        status: 'idle',
        lastSyncedAt,
        lastError: null,
        ...(typeof serverUnassignedCount === 'number' ? { serverUnassignedCount } : {}),
        ...(typeof serverPatientCount === 'number' ? { serverPatientCount } : {}),
        // 실제로 반영된 pull에 대해서만 loadedScope 갱신 (stale pull은 제외).
        ...(appliedScope !== undefined ? { loadedScope: appliedScope } : {}),
        ...(permissionDeniedCount > 0
          ? { lastPermissionDeniedCount: permissionDeniedCount, lastPermissionDeniedAt: lastSyncedAt }
          : (prev.lastPermissionDeniedCount
              ? { lastPermissionDeniedCount: 0, lastPermissionDeniedAt: null }
              : {})),
      }));
      return { ok: true, reason, lastSyncedAt };
    } catch (error) {
      console.warn('[patient-sync]', reason, error);
      setSyncState(prev => ({
        ...prev,
        status: 'error',
        lastError: (error as { message?: string } | null)?.message || 'Patient sync failed',
      }));
      return { ok: false, reason, error };
    } finally {
      inFlight = false;
      const next = queued;
      queued = null;
      if (next && getInputs().enabled) {
        queueMicrotask(() => { void runSync(next); });
      }
    }
  }

  // 환자 전환 등에서 "저장이 끝날 때까지 기다렸다가 진행" 하기 위한 예약 함수 — 새 PATCH를
  // 독자적으로 실행하지 않고 기존 autosync 큐(runSync)에 합류한다. 그렇지 않으면 마침 같은
  // 순간 실행 중인 autosync와 같은 revision으로 동시에 PATCH해 가짜 충돌(409)이 생긴다.
  function flushPatient(patientId: string): Promise<FlushOutcome> {
    // 앞선 상태(store) 기준(P2-41c). 같은 커밋의 재개 dispatch는 마이크로태스크로 미뤄져 있어(훅의 재개 effect) 옮기기 전처럼
    // 재개 전 값을 본다(계획 B7).
    const { patients: latest, activeId: latestActiveId } = store.getState();
    const current = latest.find(p => p.id === patientId);
    if (!current) return Promise.resolve('error');
    if (syncOf(current)?.syncStatus === 'conflict') return Promise.resolve('conflict');

    const eligibility = getPushEligibility(patientId, {
      activeId: latestActiveId || null,
      lockState: getInputs().lockState,
      patient: current,
    });
    // held-by-other/lost/sync-paused는 push를 시도할 이유 자체가 없으므로 즉시 확정.
    // bootstrap-pending(peeking/acquiring)만은 예외 — waiter를 등록해 대기한다.
    if (!eligibility.allowed && eligibility.reason !== 'bootstrap-pending') {
      return Promise.resolve('lock-lost');
    }
    const status = syncOf(current)?.syncStatus;
    if (status !== 'dirty' && status !== 'local-only') {
      return Promise.resolve('synced');
    }
    // 동기화 자체가 꺼져 있으면 push 사이클이 영원히 오지 않는다 — waiter를 등록해 무한
    // 대기시키지 않고 즉시 실패로 확정한다.
    if (!getInputs().enabled) return Promise.resolve('error');

    return new Promise(resolve => {
      const targetCycleId = cycleCounter + 1; // "지금부터 새로 시작되는 사이클"만 나를 만족시킴
      const waiters = flushWaiters.get(patientId) || [];
      flushWaiters.set(patientId, [...waiters, { resolve, targetCycleId }]);
      void runSync({ push: true, reason: 'flush' }); // in-flight면 기존 큐 병합 동작 그대로
    });
  }

  // usePatientLock이 활성 환자에 대해 held-by-other/lost/403/acquire 네트워크 실패로
  // "확정"되면(§4-4의 재-flush 트리거가 절대 오지 않는 종결 상태) App.jsx가 이 함수를 호출해
  // bootstrap-pending으로 대기 중이던 waiter를 직접 정리한다 — 그렇지 않으면 push 사이클이
  // 영원히 안 올 waiter가 비활성화/언마운트까지 남는다.
  function notifyLockOutcome(patientId: string, outcome: FlushOutcome): void {
    const waiters = flushWaiters.get(patientId);
    if (!waiters) return;
    waiters.forEach(w => w.resolve(outcome));
    flushWaiters.delete(patientId);
  }

  function settleWaiters(patients: PatientRecord[]): void {
    if (flushWaiters.size === 0) return;
    for (const [patientId, waiters] of flushWaiters) {
      const status = syncOf(patients.find(x => x.id === patientId))?.syncStatus;
      if (status === 'synced') {
        waiters.forEach(w => w.resolve('synced'));
        flushWaiters.delete(patientId);
      } else if (status === 'conflict') {
        waiters.forEach(w => w.resolve('conflict'));
        flushWaiters.delete(patientId);
      }
    }
  }

  function disposeWaiters(): void {
    for (const waiters of flushWaiters.values()) waiters.forEach(w => w.resolve('error'));
    flushWaiters.clear();
  }

  function resumePatient(patientId: string, lockStatus: string | undefined, session: unknown): void {
    if (!store.getState().patients.some(p => p.id === patientId && syncOf(p)?.syncPaused)) return;
    store.dispatch(patientTx.patientResumed({ id: patientId, lockStatus, session }));
  }

  return { runSync, flushPatient, notifyLockOutcome, settleWaiters, disposeWaiters, resumePatient };
}
