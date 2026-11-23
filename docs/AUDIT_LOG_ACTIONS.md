# 감사 로그(Audit Log) 액션 레퍼런스

`audit_logs` 테이블에 실제로 기록되는 `action` 값 전수 목록. 관리자 콘솔(`/api/admin/audit`)에서
특정 이벤트를 찾을 때 검색어로 무엇을 넣어야 하는지 참고하기 위한 문서.

> 코드가 실제 소스(source of truth)이며 이 문서는 스냅샷이다. 라우터/핸들러를 수정해
> action 값이 바뀌거나 추가되면 이 문서도 함께 갱신할 것.
> 기준 시점: 2026-08-01, `server/src/routes/*.ts`, `server/src/middleware/audit.ts` 기준.

## 검색 동작 주의사항

- 관리자 콘솔의 action 필터는 **완전 일치**다 (`server/src/routes/admin.ts` — `action = $n`).
  부분 문자열/LIKE 검색이 아니므로 정확한 값을 넣어야 하며, prefix로 훑고 싶다면 DB에서
  직접 `WHERE action LIKE 'patient_%'` 조회가 필요하다.
- `outcome`(success/failure/denied) 배지로 실패 건만 거를 수 있지만, **같은 action 안에
  여러 실패 사유(404/409/423/500 등)가 섞여서 잡힌다.** 대부분의 라우터에서
  `res.locals.auditErrorCode`를 세팅하지 않아 `extra`가 비어 있기 때문에, action +
  outcome만으로는 정확히 "무엇이" 실패했는지 구분되지 않는다.
- 예외적으로 `patient_lock_observed_block`은 락 충돌 상황인데도 `outcome = success`로
  찍힌다(요청을 막지 않았기 때문). 실패 필터로는 안 잡히니 action명으로 직접 찾아야 한다.
- `preset.*` 계열만 점(`.`) 표기를 쓴다. 다른 모든 action은 snake_case.

## A. 라우터 레벨 자동 기록 (`auditMiddleware` / `audit(...)`)

요청이 해당 라우트를 타면 상태 코드로 outcome이 자동 결정된다
(401/403 → `denied`, ≥400 → `failure`, 그 외 → `success`).

| action | 파일:라인 | 비고 |
|---|---|---|
| `patient_list` | `patients.ts:1222,1230` | 목록 조회 + doctor-counts |
| `patient_read` | `patients.ts:1236` | 단건 조회 |
| `patient_create` | `patients.ts:1242` | 생성. 환자번호 중복/신원 충돌(409)도 여기 실패로 잡힘 |
| `patient_update` | `patients.ts:1248` | PATCH. **revision 충돌(409), 락 충돌(423)도 여기 실패로 잡힘** |
| `patient_delete` | `patients.ts:1254` | |
| `workspace_list` | `workspaces.ts:467` | |
| `workspace_load` | `workspaces.ts:473` | |
| `workspace_save` | `workspaces.ts:479` | 저장 충돌도 여기 실패로만 잡힘 |
| `workspace_overwrite` | `workspaces.ts:485` | |
| `workspace_delete` | `workspaces.ts:494` | |
| `autosave_load` | `autosave.ts:123` | |
| `autosave_save` | `autosave.ts:129` | |
| `autosave_delete` | `autosave.ts:135` | |
| `ai_analyze` | `ai.ts:133` | AI 분석 프록시 호출 |

## B. 핸들러 내부 수동 기록 (이벤트별 outcome/extra 명시)

### 인증/계정
| action | 파일:라인 |
|---|---|
| `auth_login` | `middleware/audit.ts:112` |
| `auth_logout` | `middleware/audit.ts:125` |
| `auth_refresh` | `middleware/audit.ts:155` |
| `auth_refresh_fail` | `middleware/audit.ts:136` |
| `auth_change_password` | `auth.ts:473` |
| `auth_change_password_fail` | `auth.ts:420` |
| `signup_request_create` | `auth.ts:547` |

### 환자 락 / 배정
| action | 파일:라인 | 비고 |
|---|---|---|
| `patient_lock_acquire` | `patients.ts:1130` | |
| `patient_lock_takeover` | `patients.ts:1110` | 관리자 강제 회수 |
| `patient_lock_observed_block` | `patients.ts:185,971`; `videoAnalysis.ts:892` | observe 모드에서 락 충돌인데 차단은 안 한 경우. `outcome=success`, `extra.holderName`에 점유자 이름 |
| `patient_assignment_change` | `patients.ts:1027` | 담당의 재배정 |
| `patient_assignment_force` | `patients.ts:1027` | 담당의 강제 재배정 |

### 프리셋
| action | 파일:라인 |
|---|---|
| `preset.create` | `presets.ts:125` |
| `preset.update` | `presets.ts:232` |
| `preset.delete` | `presets.ts:300` |

### 디바이스
| action | 파일:라인 | 비고 |
|---|---|---|
| `device_register` | `routes/devices.ts` | 새 PC(장치 서명 키)의 승인 대기 행 |
| `device_register_duplicate` | `routes/devices.ts` | 세션 기관에 이미 있는 PC — 새 행 없이 PC의 첫 행 ID·상태를 돌려줌(`extra.pcStatus`) |
| `device_register_other_org` | `routes/devices.ts` | 다른 기관에 등록된 PC — 거부(409), 행 없음. 상대 기관은 남기지 않고 `extra.fingerprintPrefix`만 |
| `device_approve` | `routes/admin/devices.ts` | 해지 행이 있는 PC의 승인 대기 행은 승인하지 않는다(409 `DEVICE_PC_REVOKED`) |
| `device_revoke` | `routes/admin/devices.ts` | 같은 PC(관리자 범위 안)의 모든 행을 해지, `extra.revokedDeviceIds` |
| `emr_audit_denied` | `routes/audit.ts` | 서명은 맞는데 PC가 해지·승인 대기인 EMR 감사 요청. PC당 10분에 한 건(`extra.pcStatus`·`emrAction`·`suppressed`) |
| `device_user_mismatch` | (7.3.2부터 기록하지 않음) | 예전 기록만 남아 있다 — 같은 기관 사용자는 승인된 PC에서 EMR 감사 기록을 남길 수 있다 |
| `device_org_mismatch` | `routes/audit.ts` | EMR 감사 요청의 세션 기관 ≠ PC의 기관. PC당 10분에 한 건, 그사이 건수는 다음 행의 `extra.suppressed` |

### 관리자 콘솔
| action | 파일:라인 |
|---|---|
| `admin_audit_view` | `admin.ts:276` |
| `admin_workspace_purge` | `admin.ts:330` |
| `admin_user_create` | `admin.ts:420` |
| `admin_user_reset_password` | `admin.ts:522` |
| `admin_user_disable` | `admin.ts:570` |
| `admin_user_enable` | `admin.ts:610` |
| `admin_signup_approve` | `admin.ts:758` |
| `admin_signup_reject` | `admin.ts:804` |
| `admin_presets_set_visibility` | `admin.ts:972` |
| `org_settings_update` | `admin.ts:877` |

### 영상 분석
| action | 파일:라인 |
|---|---|
| `video_analysis_upload` | `videoAnalysis.ts:371` |
| `video_analysis_submit` | `videoAnalysis.ts:586` |
| `video_analysis_close_review` | `videoAnalysis.ts:730` |
| `video_analysis_apply` | `videoAnalysis.ts:963` |

### 통계 워크벤치
| action | 파일:라인 | 비고 |
|---|---|---|
| `stats_access_denied` | `middleware/requireCapability.ts:46` | capability 없음(PR0-A, 이 문서에 그동안 누락돼 있었음 — PR0-C에서 보강) |
| `stats_preview` | `routes/stats.ts` | `POST /preview`. `extra`에 recipeDigest/sourceDigest/resultDigest/reasonCode 등(raw filter 값은 절대 안 남김, §7.4). 코호트 미달·differencing 초과로 억제된 응답도 `outcome:'denied'`로 기록됨. `GET /catalog`는 감사하지 않음(정적 메타데이터) |
| `stats_export_aggregate` | `statsExportHandler.ts` | `POST /export`(PR2). 저장된 `stats_runs` 행(이미 억제 적용됨)을 CSV로 포맷해 내보낼 때만 기록 — recipe 재계산 없음. `outcome:'denied'`는 run 조회 실패(존재하지 않음/만료/미완료) 시. 이 감사 INSERT가 실패하면 CSV는 한 바이트도 전송되지 않는다(§7.4 원칙을 aggregate 등급에도 적용) |

### EMR (Electron → 서버, 화이트리스트 강제)
| action | 파일:라인 |
|---|---|
| `emr_inject` | `audit.ts:52` |
| `emr_extract_record` | `audit.ts:53` |
| `emr_extract_consultation` | `audit.ts:54` |
| `audit_queue_corrupt` | `audit.ts:55` | 클라이언트 암호화 큐 손상 진단용 |

`EMR_AUDIT_ACTIONS` Set(`audit.ts:51-55`) 밖의 값은 요청 자체가 400으로 거부되므로,
이 4개 외의 `emr_*` 액션은 존재할 수 없다.

**PC와 기관**: 서버는 요청 헤더의 장치 ID가 아니라 서명으로 PC(장치 서명 키 = 공개키 지문)를 찾는다. 행의
`actor_org_id`는 언제나 그 PC의 기관이다. 같은 키가 여러 기관에 등록돼 있으면 행위자·기관을 비우고
`org_unresolved`를 단다(최상위 관리자에게만 보인다).

**`extra`의 서버 표시**(`devices/emrAuditRecord.ts`의 `SERVER_RESERVED_EXTRA_KEYS` — 클라이언트가 같은 이름을
보내면 지우고 서버 값을 쓴다):

| 키 | 뜻 |
|---|---|
| `deviceId` | PC의 첫 등록 행 ID(승인·해지로 바뀌지 않는다) |
| `header_device_id` | 요청 헤더의 장치 ID 원문 |
| `source` | 항상 `electron-main`. 클라이언트가 보낸 `source`(직접입력의 `auto`/`edited`)는 `client_source` |
| `actor_source` | 행위자를 정한 방법: `session_fallback`(세션 사용자) · `device_registrant`(PC의 첫 승인 행 등록자) · `none`(기관 미확정) |
| `actor_uncertain` | 행위자를 기록 시점 그대로 확인하지 못함 |
| `session_missing`·`actor_from_queue` | 로그인 세션 없이 들어온 기록 |
| `sent_by_user_id` | 행위자와 다른 경우의 전송 세션 사용자 |
| `legacy_shell`·`occurred_at_unknown` | 발생 시각을 보내지 않는 이전 설치본의 기록 — 행 시각은 서버 수신 시각 |
| `burst` | 이전 설치본의 기록이 같은 PC의 직전 기록과 1초 안에 들어옴(쌓인 기록을 몰아서 보낸 것) |
| `org_unresolved` | 같은 키가 여러 기관에 등록돼 있어 기관을 정하지 못함 |

## 개선 여지

- `patients.ts`, `workspaces.ts` 등 라우터 레벨 자동 기록(A절)은 실패 사유를 구분하지 못한다.
  DB revision 충돌만 따로 찾고 싶다면, 핸들러가 실패 시
  `res.locals.auditErrorCode = 'CONFLICT'` 같은 값을 세팅하도록 고쳐서
  `extra.responseCode`로 필터링 가능하게 만드는 개선이 필요하다
  (`middleware/audit.ts:78`, `res.locals.auditErrorCode` 참고).
