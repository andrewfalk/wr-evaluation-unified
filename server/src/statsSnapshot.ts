// PR0-C §1.1/§B — snapshot 계약. `BEGIN ... ISOLATION LEVEL REPEATABLE READ, READ ONLY`
// 트랜잭션 안에서 case 행을 결정적으로 정렬해 조회하고, Python(향후 PR1)이 끝날 때까지
// 열어두지 않고 트랜잭션을 즉시 종료한다(§1.1 순서 4).
import type { Pool, PoolClient } from 'pg';
import { canonicalDigest } from './canonicalSerializer';

export interface SnapshotRow {
  id: string;
  patientPersonId: string;
  assignedDoctorUserId: string | null;
  createdAt: Date;
  payload: Record<string, unknown>;
}

export interface Snapshot {
  rows: SnapshotRow[];
  snapshotAsOf: string;
  sourceDigest: string;
}

interface SnapshotDbRow {
  id: string;
  patient_person_id: string;
  assigned_doctor_user_id: string | null;
  created_at: Date;
  payload: Record<string, unknown>;
}

// §E — sourceDigest 입력. 결과에 영향을 줄 수 있는 스냅샷 컬럼 전부를 포함한다: personId
// (personCount/clustering), 담당의(distinctAssignedDoctorClusters), createdAt
// (deterministicMigrate의 3단계 폴백 중 하나) — snapshotAsOf는 절대 포함하지 않는다(§E,
// 실행마다 달라지는 순수 메타데이터이므로 넣으면 "행이 같아도 조회 시각이 다르면 다른
// digest"가 되어 무결성 검증의 의미가 깨진다).
function computeSourceDigest(organizationId: string, rows: SnapshotRow[]): string {
  return canonicalDigest({
    organizationId,
    grain: 'case',
    rows: rows.map((r) => ({
      caseId: r.id,
      patientPersonId: r.patientPersonId,
      assignedDoctorUserId: r.assignedDoctorUserId,
      createdAtIso: r.createdAt.toISOString(),
      payloadDigest: canonicalDigest(r.payload),
    })),
  });
}

export async function readSnapshot(pool: Pool, organizationId: string): Promise<Snapshot> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');

    const { rows: clockRows } = await client.query<{ snapshot_as_of: Date }>(
      'SELECT clock_timestamp() AS snapshot_as_of',
    );
    const snapshotAsOf = clockRows[0].snapshot_as_of.toISOString();

    // 배제 조건(명시): deleted_at IS NOT NULL(soft delete) — 배제. organization_id 불일치
    // — 배제(파라미터화된 WHERE로 구조적 강제). completion_status/담당의 미배정 등은
    // 배제하지 않는다 — 개별 변수의 missing이 이미 이를 표현하므로 행 자체를 빼면
    // caseCount가 조직의 실제 케이스 수와 어긋난다.
    const { rows } = await client.query<SnapshotDbRow>(
      `SELECT id, patient_person_id, assigned_doctor_user_id, created_at, payload
       FROM patient_records
       WHERE organization_id = $1 AND deleted_at IS NULL
       ORDER BY id ASC`,
      [organizationId],
    );

    await client.query('COMMIT');

    const snapshotRows: SnapshotRow[] = rows.map((r) => ({
      id: r.id,
      patientPersonId: r.patient_person_id,
      assignedDoctorUserId: r.assigned_doctor_user_id,
      createdAt: r.created_at,
      payload: r.payload,
    }));

    return {
      rows: snapshotRows,
      snapshotAsOf,
      sourceDigest: computeSourceDigest(organizationId, snapshotRows),
    };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
