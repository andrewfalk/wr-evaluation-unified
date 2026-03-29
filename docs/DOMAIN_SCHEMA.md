# Domain Schema

> Status: Draft for integration preparation
> Last updated: 2026-03-28
> Scope: Frontend canonical data model for local storage, Electron file storage, future intranet API, and future MongoDB mapping

Related documents:

- `docs/MODULE_STORAGE_CONVENTIONS.md`
- `docs/INTRANET_API_CONTRACT.md`
- `docs/MOCK_INTRANET_API.md`

## 1. Purpose

This document defines the canonical data model of `wr-evaluation-unified`.

It is not only a database schema document.
It is the shared contract for:

- React state shape
- localStorage / Electron file storage shape
- future intranet API payloads
- future MongoDB document mapping
- future module extension rules

The main goal is to make future integration easy without forcing a backend implementation right now.

## 2. Design Principles

### 2.1 Shared vs Module-specific data

- Data used across multiple modules belongs in `patient.data.shared`
- Data owned by a specific module belongs in `patient.data.modules.<moduleId>`
- Active module list belongs in `patient.data.activeModules`

### 2.2 Stable patient identity

- `patient.id` is the local primary key used by the app
- `patient.sync.serverId` is the future server-side identifier
- Local ID and server ID must be treated as separate concepts

### 2.3 Server integration readiness

- Every patient record may carry ownership and sync metadata
- The app must work even if server metadata is absent
- Future intranet integration should extend this schema, not replace it

### 2.4 Module extensibility

- New modules must avoid writing shared data into arbitrary module-local fields
- New modules should store only module-owned evaluation fields under `data.modules.<moduleId>`
- Cross-module links should use IDs, not duplicated free-form text

## 3. Entity Overview

The current domain model is centered around these entities:

1. `PatientRecord`
2. `SharedData`
3. `Diagnosis`
4. `SharedJob`
5. `ModuleData`
6. `WorkspaceSnapshot`
7. `AutoSaveEnvelope`
8. `AppSettings`
9. `AuthSession`

## 4. Canonical Patient Record

### 4.1 Canonical JSON shape

```json
{
  "id": "local-uuid",
  "createdAt": "2026-03-28T10:00:00.000Z",
  "updatedAt": "2026-03-28T10:10:00.000Z",
  "phase": "evaluation",
  "meta": {
    "organizationId": "org-1",
    "ownerUserId": "user-1",
    "createdBy": "user-1",
    "updatedBy": "user-1",
    "authMode": "local",
    "source": "web"
  },
  "sync": {
    "serverId": null,
    "revision": 0,
    "syncStatus": "local-only",
    "lastSyncedAt": null
  },
  "data": {
    "shared": {
      "name": "Patient Name",
      "gender": "male",
      "height": "175",
      "weight": "78",
      "birthDate": "1970-03-15",
      "injuryDate": "2024-06-01",
      "evaluationDate": "2024-12-15",
      "hospitalName": "Hospital Name",
      "department": "Department Name",
      "doctorName": "Doctor Name",
      "specialNotes": "",
      "diagnoses": [],
      "jobs": []
    },
    "modules": {
      "knee": {},
      "spine": {}
    },
    "activeModules": ["knee", "spine"]
  }
}
```

### 4.2 Top-level field definitions

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `string` | Yes | Local patient identifier used by the app |
| `createdAt` | `string \| null` | Yes | Record creation timestamp in ISO format |
| `updatedAt` | `string \| null` | No | Last local edit timestamp in ISO format |
| `phase` | `'intake' \| 'evaluation'` | Yes | High-level workflow stage |
| `meta` | `PatientMeta` | Recommended | Ownership and context metadata |
| `sync` | `PatientSync` | Recommended | Future server sync metadata |
| `data` | `PatientData` | Yes | Core patient content |

## 5. Patient Metadata

### 5.1 `meta`

```json
{
  "organizationId": "org-1",
  "ownerUserId": "user-1",
  "createdBy": "user-1",
  "updatedBy": "user-1",
  "authMode": "local",
  "source": "web"
}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `organizationId` | `string \| null` | Recommended | Organization or tenant scope |
| `ownerUserId` | `string \| null` | Recommended | Logical owner of the patient record |
| `createdBy` | `string \| null` | Recommended | User who first created the record |
| `updatedBy` | `string \| null` | Recommended | User who last modified the record |
| `authMode` | `'local' \| 'intranet'` | Recommended | Whether the record was created in local or intranet mode |
| `source` | `'web' \| 'electron' \| string` | Recommended | Runtime source of the record |

### 5.2 `sync`

```json
{
  "serverId": "mongo-object-id-or-guid",
  "revision": 3,
  "syncStatus": "synced",
  "lastSyncedAt": "2026-03-28T10:00:00.000Z"
}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `serverId` | `string \| null` | Recommended | Future server identifier |
| `revision` | `number` | Recommended | Monotonic revision for conflict handling |
| `syncStatus` | `'local-only' \| 'dirty' \| 'synced' \| 'conflict'` | Recommended | Local/server sync state |
| `lastSyncedAt` | `string \| null` | Recommended | Timestamp of last successful sync |

### 5.3 Sync status semantics

| Value | Meaning |
|---|---|
| `local-only` | Record exists only locally and has never been uploaded |
| `dirty` | Record has a server ID but local edits are not yet synced |
| `synced` | Local content matches last known server revision |
| `conflict` | Local and remote versions diverged and need manual resolution |

## 6. Patient Data

### 6.1 `data`

```json
{
  "shared": {},
  "modules": {},
  "activeModules": ["knee", "spine"]
}
```

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `shared` | `SharedData` | Yes | Cross-module patient data |
| `modules` | `Record<string, object>` | Yes | Module-owned payloads keyed by module ID |
| `activeModules` | `string[]` | Yes | Modules enabled for the patient |

## 7. Shared Data

### 7.1 Canonical shape

```json
{
  "name": "Patient Name",
  "gender": "male",
  "height": "175",
  "weight": "78",
  "birthDate": "1970-03-15",
  "injuryDate": "2024-06-01",
  "evaluationDate": "2024-12-15",
  "hospitalName": "Hospital Name",
  "department": "Department Name",
  "doctorName": "Doctor Name",
  "specialNotes": "",
  "diagnoses": [],
  "jobs": []
}
```

### 7.2 Field definitions

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `name` | `string` | Yes | Patient name |
| `gender` | `string` | Yes | Current app uses `male` / `female` / empty |
| `height` | `string` | No | Height input as string |
| `weight` | `string` | No | Weight input as string |
| `birthDate` | `string` | No | Birth date, generally `YYYY-MM-DD` |
| `injuryDate` | `string` | No | Injury date, generally `YYYY-MM-DD` |
| `evaluationDate` | `string` | No | Date evaluation was considered complete |
| `hospitalName` | `string` | No | Hospital name |
| `department` | `string` | No | Department name |
| `doctorName` | `string` | No | Doctor name |
| `specialNotes` | `string` | No | Free text |
| `diagnoses` | `Diagnosis[]` | Yes | Diagnosis list |
| `jobs` | `SharedJob[]` | Yes | Shared occupational history |

## 8. Diagnosis

### 8.1 Base diagnosis shape

```json
{
  "id": "uuid",
  "code": "M17.1",
  "name": "Primary Osteoarthritis of Knee",
  "side": "right"
}
```

### 8.2 Base fields

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `string` | Yes | Local diagnosis identifier |
| `code` | `string` | No | Diagnosis code |
| `name` | `string` | No | Diagnosis label |
| `side` | `'right' \| 'left' \| 'both' \| ''` | No | Side information |

### 8.3 Module-specific diagnosis extensions

Diagnosis objects may carry additional fields used in specific modules.
Current examples include:

- knee-related confirmation fields
- knee-related KLG fields
- work-relatedness fields
- reason fields for low assessment cases

Rule:

- Diagnosis extension fields are allowed
- But the base diagnosis shape above must remain valid
- New modules should namespace or clearly document additional diagnosis fields

## 9. Shared Job

### 9.1 Canonical shape

```json
{
  "id": "uuid",
  "jobName": "Construction Rebar Worker",
  "presetId": null,
  "startDate": "2000-03-01",
  "endDate": "2018-12-31",
  "workPeriodOverride": "",
  "workDaysPerYear": 250
}
```

### 9.2 Field definitions

| Field | Type | Required | Meaning |
|---|---|---:|---|
| `id` | `string` | Yes | Shared job identifier used for module linking |
| `jobName` | `string` | Yes | Job title |
| `presetId` | `string \| null` | No | Preset reference ID |
| `startDate` | `string` | No | Job start date |
| `endDate` | `string` | No | Job end date |
| `workPeriodOverride` | `string` | No | Manual override for calculated period |
| `workDaysPerYear` | `number` | No | Annual work-day count |

### 9.3 Linking rule

- Shared jobs are the authoritative cross-module occupational history
- Module-specific job payloads must point to shared jobs by `sharedJobId`
- Modules should not duplicate `jobName`, `startDate`, and `endDate` unless strictly needed for migration compatibility

## 10. Module Data

For module authoring rules and storage boundaries, also see `docs/MODULE_STORAGE_CONVENTIONS.md`.

### 10.1 General rule

`patient.data.modules` is a dictionary keyed by module ID.

Example:

```json
{
  "modules": {
    "knee": {},
    "spine": {},
    "hip": {},
    "shoulder": {}
  }
}
```

### 10.2 Required rules for every module

Each module payload must follow these rules:

1. Store only module-owned fields under `data.modules.<moduleId>`
2. Keep cross-module patient facts under `data.shared`
3. Use stable IDs for repeatable nested lists
4. Link to shared records with IDs instead of duplicating text
5. Remain valid when absent
6. Support creation through a dedicated `createModuleData()` function

### 10.3 Current module schemas

#### `modules.knee`

```json
{
  "jobExtras": [
    {
      "sharedJobId": "uuid",
      "weight": "3200",
      "squatting": "200",
      "evidenceSources": [],
      "stairs": true,
      "kneeTwist": true,
      "startStop": false,
      "tightSpace": true,
      "kneeContact": true,
      "jumpDown": false
    }
  ],
  "returnConsiderations": "Avoid repetitive kneeling"
}
```

| Field | Type | Meaning |
|---|---|---|
| `jobExtras` | `KneeJobExtra[]` | Knee-specific workload factors linked to `shared.jobs[]` |
| `returnConsiderations` | `string` | Return-to-work considerations |

#### `modules.spine`

```json
{
  "tasks": [
    {
      "id": 1,
      "name": "Lifting Materials",
      "posture": "G3",
      "weight": 25,
      "frequency": 60,
      "timeValue": 5,
      "timeUnit": "sec",
      "correctionFactor": 1.0,
      "force": 0,
      "sharedJobId": "uuid"
    }
  ]
}
```

| Field | Type | Meaning |
|---|---|---|
| `tasks` | `SpineTask[]` | Spine-specific MDDM tasks, optionally linked to `shared.jobs[]` |

## 11. Workspace Snapshot

### 11.1 Purpose

Workspace snapshots are a convenience storage concept.
They are not the long-term recommended server source of truth.

### 11.2 Canonical shape

```json
{
  "id": 1,
  "name": "March review set",
  "count": 2,
  "savedAt": "2026-03-28T10:00:00.000Z",
  "patients": []
}
```

### 11.3 Rules

- Snapshot stores a patient list as saved by the user at that time
- Local and Electron modes may keep full patient payloads inside snapshots
- Future intranet mode may keep either full patient payloads or server-backed references
- If the implementation moves to server references later, the API must still map back to this logical shape for compatibility

## 12. AutoSave Envelope

### 12.1 Canonical shape

```json
{
  "savedAt": "2026-03-28T10:00:00.000Z",
  "patients": []
}
```

### 12.2 Rules

- Autosave is temporary recovery data
- It may be stored locally or remotely depending on integration mode
- It is not the same as an explicitly named workspace snapshot

## 13. App Settings

### 13.1 Canonical shape

```json
{
  "theme": "light",
  "fontSize": "medium",
  "hospitalName": "Hospital Name",
  "department": "Department Name",
  "doctorName": "Doctor Name",
  "autoSaveInterval": 30,
  "integrationMode": "local",
  "apiBaseUrl": "",
  "geminiApiKey": "",
  "claudeApiKey": ""
}
```

### 13.2 Important notes

- `integrationMode` is currently `local` or `intranet`
- `apiBaseUrl` is the preferred root URL for future intranet APIs
- Electron-only API keys are transitional and should move server-side in a real intranet deployment

## 14. Auth Session

### 14.1 Canonical shape

```json
{
  "version": 1,
  "mode": "local",
  "status": "ready",
  "accessToken": null,
  "apiBaseUrl": "",
  "refreshedAt": "2026-03-28T10:00:00.000Z",
  "user": {
    "id": "web-local-user",
    "displayName": "Local User",
    "email": "",
    "role": "clinician",
    "organizationId": "local-web-workspace",
    "authProvider": "local-fallback"
  }
}
```

### 14.2 Rules

- Current local mode uses a fallback local session
- Future intranet mode should replace this with real login session data
- Frontend session fields should remain backward-compatible where possible

## 15. Backend Mapping Guidance

For future MongoDB integration, the recommended direction is:

- `patients` collection as first-class source of truth
- `workspaces` collection for named snapshot sets
- `autosaves` collection or per-user autosave record
- `users` and `organizations` managed by the intranet system

### 15.1 Recommended mapping

| Frontend concept | Recommended backend concept |
|---|---|
| `patient.id` | Client-local UUID |
| `patient.sync.serverId` | Mongo `_id` or API GUID |
| `patient.sync.revision` | Server-side document revision |
| `workspace.id` | Workspace document ID |
| `session.user.organizationId` | Tenant / organization scope |

## 16. Module Extension Rules

When adding a new module such as `hip` or `shoulder`:

1. Register it with a unique `moduleId`
2. Add only module-owned fields under `data.modules.<moduleId>`
3. Reuse `shared.diagnoses` and `shared.jobs` when the data is cross-module
4. Use ID-based links for shared occupational history
5. Document the new module payload in this file
6. Keep migration logic explicit when moving legacy fields into shared fields

## 17. Migration Rules

### 17.1 Supported legacy migration patterns

The current code already supports:

- single-module legacy records using `moduleId + data.module`
- migration of old knee job arrays into `shared.jobs + modules.knee.jobExtras`
- migration of old spine job text fields into `shared.jobs`

### 17.2 Future migration rule

Any schema change should define:

- old shape
- new shape
- migration trigger point
- whether migration is lossy or lossless

## 18. Open Decisions

These items are intentionally left open until actual intranet connection begins:

1. Whether remote workspaces should store full patient snapshots or only patient references
2. Whether `revision` is numeric, timestamp-based, or ETag-derived
3. Whether conflict resolution is patient-level or workspace-level
4. Whether module-specific diagnosis extension fields should eventually be normalized
5. Whether Electron local AI key storage will remain for offline desktop-only usage

## 19. Immediate Recommendation

Before adding more modules, use this document as the rule for:

- top-level patient shape
- `shared` vs `modules` ownership
- cross-module ID linking
- future server metadata fields

That will keep future intranet integration much easier and reduce cleanup work later.
