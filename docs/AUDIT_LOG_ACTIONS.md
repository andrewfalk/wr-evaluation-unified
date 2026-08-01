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
| `device_register` | `devices.ts:91` | |
| `device_register_duplicate` | `devices.ts:91` | |
| `device_approve` | `admin.ts:126` | |
| `device_revoke` | `admin.ts:171` | |
| `device_user_mismatch` | `audit.ts:165` | EMR 서명 검증 실패 |
| `device_org_mismatch` | `audit.ts:165` | EMR 서명 검증 실패 |

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

### EMR (Electron → 서버, 화이트리스트 강제)
| action | 파일:라인 |
|---|---|
| `emr_inject` | `audit.ts:52` |
| `emr_extract_record` | `audit.ts:53` |
| `emr_extract_consultation` | `audit.ts:54` |
| `audit_queue_corrupt` | `audit.ts:55` | 클라이언트 암호화 큐 손상 진단용 |

`EMR_AUDIT_ACTIONS` Set(`audit.ts:51-55`) 밖의 값은 요청 자체가 400으로 거부되므로,
이 4개 외의 `emr_*` 액션은 존재할 수 없다.

## 개선 여지

- `patients.ts`, `workspaces.ts` 등 라우터 레벨 자동 기록(A절)은 실패 사유를 구분하지 못한다.
  DB revision 충돌만 따로 찾고 싶다면, 핸들러가 실패 시
  `res.locals.auditErrorCode = 'CONFLICT'` 같은 값을 세팅하도록 고쳐서
  `extra.responseCode`로 필터링 가능하게 만드는 개선이 필요하다
  (`middleware/audit.ts:78`, `res.locals.auditErrorCode` 참고).
