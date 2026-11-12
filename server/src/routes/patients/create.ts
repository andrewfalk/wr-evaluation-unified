// POST /api/patients — create or idempotent replay. Split out of routes/patients.ts (S5 P1-29); the
// transaction moved to domain/patients/createPatient.ts (S7-3), the responses are unchanged.
import { randomUUID } from 'crypto';
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { createPatient as createPatientRecord } from '../../domain/patients/patientRecordsService';
import { patientWriteContextOf } from '../../http/patientWriteContext';
import { CreateBody } from './schemas';
import { uniqueConflictResponse, identityConflictResponse, personVanishedResponse, extractMeta, normalizePatientDates, invalidBirthDateResponse, toResponse } from './shared';

// ---------------------------------------------------------------------------
// POST /api/patients
// Requires Idempotency-Key header. Validation here; the transaction in createPatientRecord.
// ---------------------------------------------------------------------------
export async function createPatient(pool: Pool, req: Request, res: Response): Promise<void> {
  // 세션·조직 확인(sessionOf → orgIdOf)은 이전처럼 검증보다 먼저.
  const ctx = patientWriteContextOf(req);

  const idempKey = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim() : null;

  if (!idempKey) {
    res.status(400).json({ code: 'IDEMPOTENCY_KEY_REQUIRED', error: 'Idempotency-Key header is required' });
    return;
  }

  // Validate body before touching the DB so a bad request never reserves a slot.
  const parse = CreateBody.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ code: 'INVALID_BODY', error: parse.error.issues });
    return;
  }

  const {
    id: clientId, phase, createdAt, data: rawData,
    modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion,
  } = parse.data;

  // DB를 건드리기 전에 검증 — 잘못된 날짜가 payload와 DATE 컬럼 어디에도 남지 않게.
  const dates = normalizePatientDates(rawData as Record<string, unknown>);
  if (!dates.ok) {
    res.status(400).json(invalidBirthDateResponse(dates.failures));
    return;
  }
  const data = dates.data;
  const meta = extractMeta(data);

  if (!meta.name) {
    res.status(400).json({ code: 'NAME_REQUIRED', error: 'Patient name (data.shared.name) is required' });
    return;
  }

  const patientId = clientId ?? randomUUID();

  // 트랜잭션(슬롯 예약 → 담당의·person 해석 → INSERT → 슬롯 확정)은 domain/patients/createPatient.ts(S7-3).
  // 결과마다 이전과 같은 응답을 쓴다.
  const result = await createPatientRecord(pool, ctx, {
    idempotencyKey: idempKey,
    patientId,
    phase,
    createdAt,
    data,
    meta,
    report: { modulesCompleteObserved, completionClientBuildVersion, completionClientSchemaVersion },
    buildBody: toResponse,
  });
  switch (result.kind) {
    case 'created':
      res.status(201).json(result.body);
      return;
    case 'replayed':
      // Completed response — replay it.
      res.status(result.status).json(result.body);
      return;
    case 'idempotency_in_progress':
      res.status(409).json({ code: 'IDEMPOTENCY_IN_PROGRESS', error: 'A request with this Idempotency-Key is already in progress. Please retry shortly.' });
      return;
    case 'identity_conflict':
      res.status(409).json(identityConflictResponse());
      return;
    case 'person_vanished':
      res.status(409).json(personVanishedResponse());
      return;
    case 'unique_conflict':
      res.status(409).json(uniqueConflictResponse(result.error));
      return;
  }
}
