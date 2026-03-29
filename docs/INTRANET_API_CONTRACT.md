# Intranet API Contract

Related documents:

- `docs/DOMAIN_SCHEMA.md`
- `docs/MODULE_STORAGE_CONVENTIONS.md`
- `docs/MOCK_INTRANET_API.md`

This app can now switch between `local` storage and `intranet` API mode.
When `integrationMode` is set to `intranet`, the frontend will prefer these endpoints.

## Session headers

The frontend may send these headers:

- `Authorization: Bearer <token>`
- `X-WR-User-Id: <user id>`
- `X-WR-Org-Id: <organization id>`
- `X-WR-Auth-Mode: intranet`

## Workspace endpoints

### `GET /api/workspaces`

Response:

```json
{
  "items": [
    {
      "id": 1,
      "name": "March review set",
      "count": 2,
      "savedAt": "2026-03-28T10:00:00.000Z",
      "patients": []
    }
  ]
}
```

### `POST /api/workspaces`

Request:

```json
{
  "name": "March review set",
  "patients": []
}
```

Response:

```json
{
  "items": []
}
```

### `DELETE /api/workspaces/:id`

Response:

```json
{
  "items": []
}
```

## Autosave endpoints

### `GET /api/autosave`

Response:

```json
{
  "savedAt": "2026-03-28T10:00:00.000Z",
  "patients": []
}
```

### `PUT /api/autosave`

Request:

```json
{
  "patients": []
}
```

Response:

```json
{
  "ok": true
}
```

### `DELETE /api/autosave`

Response:

```json
{
  "ok": true
}
```

## Patient record metadata

Patient payloads should follow the canonical shapes and ownership rules documented in:

- `docs/DOMAIN_SCHEMA.md`
- `docs/MODULE_STORAGE_CONVENTIONS.md`

Each patient record may now include these fields for future sync support:

```json
{
  "meta": {
    "organizationId": "org-1",
    "ownerUserId": "user-1",
    "createdBy": "user-1",
    "updatedBy": "user-1",
    "authMode": "intranet",
    "source": "web"
  },
  "sync": {
    "serverId": "mongo-object-id-or-guid",
    "revision": 3,
    "syncStatus": "synced",
    "lastSyncedAt": "2026-03-28T10:00:00.000Z"
  }
}
```

## Recommended backend behavior

- Store patients as first-class documents, not only as workspace snapshots.
- Enforce user and organization scoping on every request.
- Return authoritative `serverId`, `revision`, and `lastSyncedAt` values.
- Preserve snapshot-style workspaces only as a convenience feature.
- Log AI analysis requests with user and organization context.
