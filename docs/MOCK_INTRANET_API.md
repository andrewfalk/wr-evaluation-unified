# Mock Intranet API

> Status: Local development helper
> Last updated: 2026-03-29

This project includes a lightweight local mock intranet API so the frontend can exercise remote workspace and autosave flows before a real intranet server exists.

## 1. What it is for

Use this mock when you want to test:

- `integrationMode = intranet`
- remote workspace load/save/delete flow
- remote autosave load/save/clear flow
- patient payload transport shape
- user and organization scoped data separation

It is not a real backend.

It does not implement:

- real login
- real MongoDB
- real authorization
- real audit logging
- real AI analysis

## 2. Start the mock server

Run this in a separate terminal:

```bash
npm run mock:intranet
```

Default address:

```text
http://localhost:3002
```

You can change the port if needed:

```bash
$env:MOCK_INTRANET_PORT=3102
npm run mock:intranet
```

## 3. Connect the app to the mock

In the app settings:

1. Set storage mode to `intranet`
2. Set server base URL to `http://localhost:3002`
3. Save settings

After that, workspace and autosave requests will go to the mock server.

## 4. Available endpoints

The mock server implements:

- `GET /api/workspaces`
- `POST /api/workspaces`
- `DELETE /api/workspaces/:id`
- `GET /api/autosave`
- `PUT /api/autosave`
- `DELETE /api/autosave`
- `GET /api/mock/status`
- `POST /api/analyze` returns `501` on purpose

The `501` response for `/api/analyze` is intentional.
The frontend should then fall back to the normal `/api/analyze` route when `apiBaseUrl` is set.

## 5. Storage behavior

Mock data is stored locally in:

```text
.mock-intranet/db.json
```

The file is ignored by git.

The mock separates data by these request headers:

- `X-WR-User-Id`
- `X-WR-Org-Id`

That means different users or organizations can see different mock workspace lists and autosave data.

## 6. Quick verification

You can check the current mock scope with:

```bash
curl http://localhost:3002/api/mock/status
```

Expected response shape:

```json
{
  "ok": true,
  "mock": true,
  "port": 3002,
  "scope": {
    "scopeKey": "org::user",
    "userId": "user",
    "organizationId": "org",
    "authMode": "intranet"
  },
  "workspaceCount": 0,
  "hasAutosave": false
}
```

## 7. Resetting the mock

To clear all mock data:

1. Stop the mock server
2. Delete `.mock-intranet/db.json`
3. Start `npm run mock:intranet` again

## 8. Recommended workflow

For preparation-stage testing:

1. Start the frontend as usual
2. Start the mock intranet server in another terminal
3. Switch the app to `intranet` mode
4. Set `apiBaseUrl` to `http://localhost:3002`
5. Test workspace save/load/autosave behavior

This gives you a stable contract test without waiting for the real intranet backend.
