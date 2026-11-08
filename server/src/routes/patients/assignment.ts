// POST /api/patients/:id/assignment — admin only (S7: assign).
// Split out of routes/patients.ts (S5 P1-29); handler bodies unchanged.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import config from '../../config';
import { writeAuditLog } from '../../middleware/audit';
import type { QueryRunner } from '../../db/patientPersons';
import { deleteLockForPatient, checkLockForWrite, lockPatientAnchor, PatientLockTargetNotFoundError } from '../../db/patientLocks';
import { orgIdOf, sessionOf } from '../../http/authz';
import { lockHeldResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients/:id/assignment  (admin only)
// Changes the owning doctor (owner_user_id) of a patient record.
// The target user must belong to the same organisation.
// ---------------------------------------------------------------------------
const AssignmentBody = z.object({
  assignedUserId: z.string().uuid().nullable(),
});

export async function assignPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const session = sessionOf(req);
  const orgId   = orgIdOf(req);

  const parsed = AssignmentBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_BODY', errors: parsed.error.flatten().fieldErrors });
    return;
  }

  const { assignedUserId } = parsed.data;
  const force = req.query['force'] === 'true';

  let newDoctorName: string | null = null;
  if (assignedUserId !== null) {
    // Verify target user exists in the organisation and has doctor role.
    const { rows: userRows } = await pool.query<{ id: string; role: string; name: string }>(
      `SELECT id, role, name FROM users WHERE id = $1 AND organization_id = $2 AND disabled_at IS NULL`,
      [assignedUserId, orgId]
    );
    if (userRows.length === 0) {
      res.status(404).json({ code: 'USER_NOT_FOUND', error: 'User not found in this organization' });
      return;
    }
    if (userRows[0].role !== 'doctor') {
      res.status(422).json({ code: 'TARGET_NOT_A_DOCTOR', error: 'Assigned user must have the doctor role' });
      return;
    }
    newDoctorName = userRows[0].name;
  }

  // 일반·force 두 경로 모두 같은 앵커+락 확인을 거친다 — force 경로에만 앵커를 잡으면
  // 일반 재배정과 acquire/force가 서로 경합할 수 있다. off 모드에서는(기존 동작과 완전히
  // 동일하도록) 앵커·락 확인 자체를 건너뛴다.
  const client = await pool.connect();
  let forcedLockHolder: string | null = null;
  try {
    await client.query('BEGIN');

    if (config.lockEnforcementMode !== 'off') {
      await lockPatientAnchor(client as QueryRunner, { patientId: id, orgId });

      // assignPatient는 자신이 보유한 leaseToken이 없으므로(호출자가 편집 세션을 갖고 있지
      // 않음), 살아있는 락이 있으면 항상 불일치로 취급 — force가 아니면 423, force면 폐기.
      const lockCheck = await checkLockForWrite(client as QueryRunner, { patientId: id, orgId, leaseToken: null });
      if (!lockCheck.ok) {
        if (config.lockEnforcementMode === 'observe') {
          void writeAuditLog(pool, {
            actorUserId: session.userId, actorOrgId: orgId, action: 'patient_lock_observed_block',
            targetType: 'patient', targetId: id, outcome: 'success',
            ip: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null,
            extra: { holderName: lockCheck.heldBy.holderName, context: 'assignment' },
          });
        } else if (!force) {
          await client.query('ROLLBACK');
          res.status(423).json(lockHeldResponse(lockCheck.heldBy));
          return;
        } else {
          forcedLockHolder = lockCheck.heldBy.holderName;
          await deleteLockForPatient(client as QueryRunner, { patientId: id, orgId });
        }
      }
    }

    // Read previous doctor (id + name) before update for audit.
    const { rows: oldRows } = await client.query<{
      assigned_doctor_user_id: string | null;
      previous_doctor_name: string | null;
    }>(
      `SELECT pr.assigned_doctor_user_id, u.name AS previous_doctor_name
       FROM patient_records pr
       LEFT JOIN users u ON u.id = pr.assigned_doctor_user_id
       WHERE pr.id = $1 AND pr.organization_id = $2 AND pr.deleted_at IS NULL`,
      [id, orgId]
    );
    if (oldRows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }
    const previousDoctorUserId = oldRows[0].assigned_doctor_user_id;
    const previousDoctorName   = oldRows[0].previous_doctor_name;

    // Update assigned doctor, sync doctorName in payload, and bump revision.
    const { rows } = await client.query<{ id: string; revision: number }>(
      `UPDATE patient_records
       SET assigned_doctor_user_id = $1,
           payload  = jsonb_set(payload, '{data,shared,doctorName}', to_jsonb($4::text), true),
           revision = revision + 1
       WHERE id = $2 AND organization_id = $3 AND deleted_at IS NULL
       RETURNING id, revision`,
      [assignedUserId, id, orgId, newDoctorName ?? '']
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }

    await client.query('COMMIT');

    writeAuditLog(pool, {
      actorUserId: session.userId,
      actorOrgId:  orgId,
      action:      forcedLockHolder !== null ? 'patient_assignment_force' : 'patient_assignment_change',
      targetType:  'patient',
      targetId:    id,
      outcome:     'success',
      ip:          req.ip ?? null,
      userAgent:   req.headers['user-agent'] ?? null,
      extra:       { previousDoctorUserId, previousDoctorName, assignedUserId, newDoctorName, forcedLockHolder },
    });

    res.status(200).json({ patientId: id, assignedUserId, revision: rows[0].revision });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof PatientLockTargetNotFoundError) {
      res.status(404).json({ code: 'PATIENT_NOT_FOUND', error: 'Patient not found' });
      return;
    }
    throw err;
  } finally {
    client.release();
  }
}
