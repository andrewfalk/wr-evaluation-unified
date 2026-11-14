// 클라이언트 환자 레코드 타입(REFACTORING_ROADMAP Phase 2 C4, P2-32) — 환자 상태 컨테이너·전이가 쓴다.
// 서버와 공유하는 계약(@wr/contracts Patient)에서 파생하고, 클라이언트만 쓰는 필드를 더한다:
// updatedAt(편집 시각) · redacted(가림 환자) · sync.syncPaused("저장하지 않고 이동") · meta.assignedDoctorUserId ·
// sync.conflict의 code·message·holder. 모듈 데이터는 unknown(모듈마다 다름). 타입 전용 import라 번들에는 영향이 없다.
import type { PatientData, PatientMeta, PatientSync, PatientSyncConflict } from '@wr/contracts';

// kind는 선택: 클라이언트는 기존 충돌의 serverRevision만 갱신하는 등 kind 없이 충돌 객체를 만들 수 있다(conflict/deleteRevisionUpdated).
export type PatientSyncConflictRecord = Partial<PatientSyncConflict> & {
  code?: string | null;
  message?: string | null;
  holder?: unknown;
};

export type PatientSyncRecord = Partial<Omit<PatientSync, 'conflict'>> & {
  syncPaused?: boolean;
  conflict?: PatientSyncConflictRecord;
};

export type PatientMetaRecord = Partial<PatientMeta> & {
  assignedDoctorUserId?: string | null;
};

export interface PatientRecord {
  id: string;
  createdAt?: string;
  phase?: 'intake' | 'evaluation';
  data?: PatientData;
  sync?: PatientSyncRecord;
  meta?: PatientMetaRecord;
  assignedDoctorUserId?: string | null;
  updatedAt?: string;
  redacted?: boolean;
  [field: string]: unknown;
}
