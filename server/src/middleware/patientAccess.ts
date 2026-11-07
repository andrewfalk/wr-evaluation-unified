import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import { requirePatientAccess } from '../http/authz';

// PATCH/DELETE /api/patients/:id 전용 권한 가드 — 구현은 http/authz.ts requirePatientAccess(pool,
// 'write')로 옮겼다(S4 / P1-17, 동작 동일). admin 또는 담당의만 통과, 다른 org·없는 환자는 404,
// 그 외 거부는 403. 새 코드는 requirePatientAccess를 직접 쓴다.
export function assignedDoctorOrAdmin(pool: Pool): RequestHandler {
  return requirePatientAccess(pool, 'write');
}
