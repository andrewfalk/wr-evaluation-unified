// Patient metadata the write services take (S7). PatientMeta (the workspace save's per-patient fields)
// moved here from routes/workspaces/normalize.ts so that domain/ does not import routes/.

// Metadata extracted from a patient object for patient_records upsert.
export interface PatientMeta {
  id:              string;
  name:            string;
  doctorName:      string | null;
  patientNo:       string | null;
  birthDate:       string | null;
  injuryDate:      string | null;
  evaluationDate:  string | null;
  activeModules:   string[];
  diagnosesCodes:  string[];
  jobsNames:       string[];
  payload:         unknown;
  // HF1: 클라이언트 로컬 환자 id(lockTokens 조회 키)와, 클라이언트가 마지막으로 본 서버 revision
  // (sync.revision, 없으면 0). 기존 행의 revision과 다르면 덮어쓰지 않고 충돌로 보고한다.
  localId:          string | null;
  expectedRevision: number;
  // PR0-B2: 서버 완료 재검증(verifyModulesComplete)에 필요한 원본 data(shared/modules/
  // activeModules). shared/jobs 등 개별 필드만 뽑아둔 위 필드들과 달리 이건 통째로 필요하다.
  data:            Record<string, unknown> | null;
  // PR0-A: 클라이언트가 워크스페이스 저장 시점에 계산해 각 환자 객체에 실어보내는 완료
  // 보고. patientServerRepository.js가 PATCH/POST에 붙이는 것과 동일한 필드를 여기서는
  // patient 객체 최상위(payload 밖)에서 읽는다 — patients는 z.unknown()이라 스키마로
  // 강제할 수 없어 방어적으로 타입 검사한다.
  modulesCompleteObserved?:       boolean;
  completionClientBuildVersion?:  string;
  completionClientSchemaVersion?: number;
}
