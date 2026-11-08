// Patients router: middleware chain per route and the route table.
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import { Router } from 'express';
import type { Pool } from 'pg';
import { createAuthMiddleware } from '../../middleware/auth';
import { adminOnly } from '../../middleware/adminOnly';
import { csrfMiddleware } from '../../middleware/csrf';
import { auditMiddleware, auditFailuresOnly } from '../../middleware/audit';
import type { AssignmentWarning, ResolveAssignedDoctorResult } from '../../db/resolveAssignedDoctor';
import { asyncHandler } from '../../http/asyncHandler';
import { requireLockToken } from '../../http/lockToken';
import { withDeadlockRetry } from '../../db/withDeadlockRetry';
import { requireOrg, requirePatientAccess } from '../../http/authz';
import { getDoctorCounts, listPatients } from './list';
import { getPatient } from './read';
import { createPatient } from './create';
import { patchPatient } from './patch';
import { deletePatient } from './delete';
import { correctPatientIdentityRoute } from './identity';
import { assignPatient } from './assignment';
import { acquireOrRenewPatientLock, releasePatientLock, peekPatientLock } from './locks';

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createPatientsRouter(pool: Pool): Router {
  const router = Router();
  const auth   = createAuthMiddleware(pool);
  const audit  = (action: string) =>
    auditMiddleware(pool, action, 'patient', (req) => req.params.id ?? null);

  router.get(
    '/',
    auth, audit('patient_list'), requireOrg(),
    asyncHandler((req, res) => listPatients(pool, req, res))
  );

  // MUST be registered before '/:id' or Express resolves 'doctor-counts' as a patient id.
  // Org patient distribution is not PHI but is audited at the same level as the list.
  router.get(
    '/doctor-counts',
    auth, audit('patient_list'), requireOrg(),
    asyncHandler((req, res) => getDoctorCounts(pool, req, res))
  );

  router.get(
    '/:id',
    auth, audit('patient_read'), requireOrg(),
    asyncHandler((req, res) => getPatient(pool, req, res))
  );

  router.post(
    '/',
    auth, csrfMiddleware, audit('patient_create'), requireOrg(),
    asyncHandler((req, res) => createPatient(pool, req, res))
  );

  router.patch(
    '/:id',
    auth, csrfMiddleware, requirePatientAccess(pool, 'write'), audit('patient_update'), requireOrg(), requireLockToken(),
    asyncHandler((req, res) => withDeadlockRetry(() => patchPatient(pool, req, res)))
  );

  router.delete(
    '/:id',
    auth, csrfMiddleware, requirePatientAccess(pool, 'write'), audit('patient_delete'), requireOrg(),
    asyncHandler((req, res) => deletePatient(pool, req, res))
  );

  router.post(
    '/:id/assignment',
    auth, adminOnly(), csrfMiddleware, requireOrg(),
    asyncHandler((req, res) => assignPatient(pool, req, res))
  );

  // 환자 단위 TTL lease lock — acquire/renew(POST), force-takeover(POST ?force=true),
  // release(DELETE)는 편집 권한(assignedDoctorOrAdmin)이 있어야 하고, peek(GET)은 기존
  // GET /:id와 동일하게 auth만으로 조회 가능(§ 락 API 미들웨어 계약).
  // renew는 25초마다 불리므로 router-level audit(...)을 달지 않는다 — 감사 로그는 핸들러
  // 내부에서 실제 최초 획득/force-takeover일 때만 수동 기록한다.
  router.post(
    '/:id/lock',
    auth, csrfMiddleware, requirePatientAccess(pool, 'write'), requireOrg(),
    asyncHandler((req, res) => acquireOrRenewPatientLock(pool, req, res))
  );

  router.delete(
    '/:id/lock',
    auth, csrfMiddleware, requirePatientAccess(pool, 'write'), requireOrg(),
    asyncHandler((req, res) => releasePatientLock(pool, req, res))
  );

  router.get(
    '/:id/lock',
    auth, requireOrg(),
    asyncHandler((req, res) => peekPatientLock(pool, req, res))
  );

  // 감사 미들웨어가 assignedDoctorOrAdmin **앞**에 온다는 점이 중요하다. 다른 라우트처럼
  // 뒤에 두면 권한 미들웨어가 403을 반환할 때 res.on('finish') 등록 전에 응답이 끝나
  // 거부 시도가 감사에 전혀 남지 않는다. 정정은 거부 사실 자체가 감사 대상이다.
  // 성공은 핸들러가 트랜잭션 안에서 patient_identity_correct로 남기므로,
  // 여기서는 auditFailuresOnly로 좁혀 중복 기록을 막는다.
  router.post(
    '/:id/identity-correction',
    auth,
    csrfMiddleware,
    auditMiddleware(pool, 'patient_identity_correct_attempt', 'patient', undefined, {
      shouldWrite: auditFailuresOnly,
    }),
    requirePatientAccess(pool, 'write'),
    requireOrg(),
    requireLockToken(),
    asyncHandler((req, res) => correctPatientIdentityRoute(pool, req, res))
  );

  return router;
}


// Re-export types so callers only need to import from this module.
export type { AssignmentWarning, ResolveAssignedDoctorResult };
// DateFieldFailure was exported by routes/patients.ts before the split; keep the module surface.
export type { DateFieldFailure } from './shared';
