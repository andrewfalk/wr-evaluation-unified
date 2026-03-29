# Module Storage Conventions

> Status: Draft for module expansion preparation
> Last updated: 2026-03-28
> Scope: Rules for adding new module payloads without breaking local storage, Electron storage, future intranet API mapping, or future MongoDB mapping

## 1. Purpose

This document defines how feature modules must store data inside a patient record.

It is meant to prevent the data model from drifting as new modules such as `hip` and `shoulder` are added.

Use this document together with:

- `docs/DOMAIN_SCHEMA.md` for the canonical patient shape
- `docs/INTRANET_API_CONTRACT.md` for future transport expectations

## 2. Runtime Contract

Each module is registered through `registerModule()` and may provide:

- `id`
- `name`
- `icon`
- `description`
- `EvaluationComponent`
- `createModuleData()`
- `createDiagnosis()` when module-specific diagnosis fields are needed
- `computeCalc()`
- `isComplete()`
- `exportHandlers`
- `tabs`

At runtime, the app stores module payloads under:

```json
{
  "data": {
    "shared": {},
    "modules": {
      "knee": {},
      "spine": {}
    },
    "activeModules": ["knee", "spine"]
  }
}
```

When a module screen is rendered, the module receives:

```json
{
  "patient": {
    "moduleId": "knee",
    "data": {
      "shared": {},
      "module": {}
    }
  }
}
```

Important implication:

- Persisted storage is `patient.data.modules.<moduleId>`
- Module components work against the normalized view `patient.data.module`
- Module code should treat that normalized view as its writable boundary

## 3. Ownership Rules

### 3.1 What belongs in `shared`

`patient.data.shared` is the source of truth for cross-module facts:

- patient identity fields
- demographics
- visit and evaluation dates
- hospital, department, and doctor metadata
- diagnosis list
- shared occupational history

### 3.2 What belongs in `modules.<moduleId>`

`patient.data.modules.<moduleId>` must contain only module-owned fields such as:

- module-specific workload factors
- module-specific task lists
- module-specific interpretation inputs
- module-specific export helper fields when those values are true domain data

### 3.3 What must not be duplicated

Do not copy these into module-local payloads unless required for legacy migration:

- patient name
- gender
- birth date
- diagnosis list
- job title
- start and end dates
- hospital metadata

If a module needs those values, it must read them from `shared`.

## 4. Persistence Rules

Every new module payload must follow these rules.

### 4.1 JSON-safe only

Persist only JSON-safe values:

- `string`
- `number`
- `boolean`
- `null`
- plain object
- plain array

Do not persist:

- functions
- `Date` objects
- `Map`, `Set`
- DOM nodes
- `File`, `Blob`
- class instances

### 4.2 Minimal valid default shape

`createModuleData()` must return the smallest valid payload for that module.

Good examples:

```json
{
  "jobExtras": [],
  "returnConsiderations": ""
}
```

```json
{
  "tasks": [
    {
      "id": 1,
      "name": "Task 1",
      "sharedJobId": ""
    }
  ]
}
```

Guidelines:

- prefer empty arrays over `undefined`
- prefer explicit empty strings for editable text inputs
- avoid pre-populating large placeholder data
- allow the payload to exist even before the module is fully filled in

### 4.3 Stable IDs for repeated items

If a module stores repeatable items, each item must have a stable identifier or stable link key.

Use:

- `id` for module-owned list items
- `sharedJobId` for links to `shared.jobs[]`
- existing diagnosis `id` when extending diagnosis-related state

Do not rely on array index as the long-term identity of persisted records.

### 4.4 Avoid UI-only state in persisted payloads

Do not save temporary UI state inside module payloads.

Examples that must stay local component state:

- selected tab
- selected job chip
- selected row index
- modal open state
- loading state
- error strings
- temporary hover state

If the value is only needed for the current session UI and can be recomputed, it should not be persisted.

### 4.5 Avoid derived values unless intentionally cached

Do not store values that can always be recomputed from source inputs.

Examples:

- totals
- scores
- summary labels
- force calculations
- completion flags

Current note:

- `modules.spine.tasks[].force` exists today for convenience and backward compatibility
- New modules should avoid introducing new derived persisted fields unless there is a clear justification

### 4.6 No auth or transport data inside module payloads

Do not put these into module data:

- access tokens
- API keys
- user session objects
- organization scoping fields
- transport metadata
- sync metadata

Those belong in session state, patient `meta`, patient `sync`, or app settings.

## 5. Shared Linking Rules

### 5.1 Jobs

`shared.jobs[]` is the authoritative occupational history.

If a module needs per-job details, it must link to the shared job by ID.

Correct pattern:

```json
{
  "jobExtras": [
    {
      "sharedJobId": "job-uuid",
      "weight": "3200"
    }
  ]
}
```

Incorrect pattern:

```json
{
  "jobs": [
    {
      "jobName": "Construction Worker",
      "startDate": "2001-01-01"
    }
  ]
}
```

### 5.2 Diagnoses

The diagnosis list belongs in `shared.diagnoses[]`.

Module-specific diagnosis extensions are allowed, but they should follow one of these patterns:

1. Extend the shared diagnosis object through `createDiagnosis()` when the fields are conceptually part of diagnosis assessment.
2. Store module-owned derived interpretation separately under `modules.<moduleId>` if it is not truly part of the diagnosis record.

Use the first option for fields like:

- confirmed diagnosis labels
- side-specific assessment fields
- low-relatedness reason sets

Use the second option for fields like:

- module-wide summary text
- batch-calculated result caches
- per-module export-only notes

### 5.3 Cross-module references

When module data must point to something owned elsewhere:

- reference by ID
- do not duplicate mutable text
- allow migration code to repair old records if earlier versions duplicated content

## 6. Current Reference Patterns

These are the current module payload patterns that future modules should imitate where applicable.

### 6.1 Knee module

```json
{
  "jobExtras": [
    {
      "sharedJobId": "job-uuid",
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

Pattern summary:

- per-job extra burden data is linked to `shared.jobs[]`
- diagnosis-specific details are kept on diagnosis objects
- module payload stays relatively small

### 6.2 Spine module

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
      "sharedJobId": "job-uuid"
    }
  ],
  "aiAnalysisResult": null
}
```

Pattern summary:

- module stores repeatable task records with task-local IDs
- tasks optionally link back to `shared.jobs[]`
- `force` is derived and should be treated as legacy convenience data
- `aiAnalysisResult` currently exists but is not a recommended pattern for new modules unless the result is intentionally part of persisted domain data

## 7. Checklist for New Modules

Before merging a new module, verify all of the following.

1. `registerModule()` uses a unique `id`.
2. `createModuleData()` returns a minimal valid payload.
3. The payload stores only module-owned data.
4. Shared facts remain in `patient.data.shared`.
5. Repeated module items use stable IDs.
6. Links to jobs use `sharedJobId` instead of copied job text.
7. The module does not persist UI-only state.
8. The module does not introduce new derived persisted fields without justification.
9. Any diagnosis extension fields are clearly documented.
10. Any legacy migration path is explicit if the module changes prior data shapes.
11. The new payload shape is documented in `docs/DOMAIN_SCHEMA.md`.

## 8. Starter Template for Future Modules

Use a structure like this when creating a new module.

```javascript
registerModule({
  id: 'hip',
  name: 'Hip',
  icon: 'H',
  description: 'Hip evaluation',
  EvaluationComponent: HipEvaluation,
  createModuleData: () => ({
    taskItems: [],
    summaryNotes: ''
  }),
  createDiagnosis: () => ({
    id: crypto.randomUUID(),
    code: '',
    name: '',
    side: '',
    hipFinding: '',
    hipSeverity: ''
  }),
  computeCalc: computeHipCalc,
  isComplete: isHipComplete,
  exportHandlers: hipExportHandlers,
  tabs: [
    { id: 'tasks', label: 'Task Review' }
  ]
});
```

Recommended payload pattern:

```json
{
  "taskItems": [
    {
      "id": "uuid",
      "sharedJobId": "job-uuid",
      "loadKg": 15,
      "repetitionsPerHour": 20
    }
  ],
  "summaryNotes": ""
}
```

## 9. Review Questions

When reviewing a new module, ask these questions:

- If `shared.jobs[]` changes, does the module still behave correctly?
- If the app switches to intranet API mode, can this payload be sent as JSON without custom serialization?
- If the module is removed from `activeModules`, does the stored payload remain harmless?
- If a patient is imported from an older record, is the migration path clear?
- If a backend later normalizes the module data, does this payload have clean ownership boundaries?

## 10. Immediate Recommendation

Before implementing `hip`, `shoulder`, or other new modules:

1. Define the module payload in this document first.
2. Confirm which fields belong in `shared` versus module-local storage.
3. Confirm link strategy for jobs and diagnoses.
4. Only then implement `createModuleData()` and UI state.

That order will keep future intranet integration much easier and prevent cleanup work later.
