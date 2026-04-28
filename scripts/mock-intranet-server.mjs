import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import {
  MockStoreSchema,
  SaveWorkspaceRequestSchema,
  PutAutosaveRequestSchema,
  GetWorkspacesResponseSchema,
  GetAutosaveResponseSchema,
  PutAutosaveResponseSchema,
  DeleteAutosaveResponseSchema,
} from '../shared/dist/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = Number(process.env.MOCK_INTRANET_PORT || 3002);
const STORAGE_DIR = path.join(__dirname, '..', '.mock-intranet');
const STORAGE_FILE = path.join(STORAGE_DIR, 'db.json');

function ensureStorage() {
  if (!fs.existsSync(STORAGE_DIR)) {
    fs.mkdirSync(STORAGE_DIR, { recursive: true });
  }

  if (!fs.existsSync(STORAGE_FILE)) {
    fs.writeFileSync(
      STORAGE_FILE,
      JSON.stringify({ version: 1, scopes: {} }, null, 2),
      'utf8'
    );
  }
}

function readStore() {
  ensureStorage();

  try {
    const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    const result = MockStoreSchema.safeParse(parsed);
    if (!result.success) {
      console.warn('[mock-intranet] db.json schema mismatch, resetting:', result.error.issues);
      return { version: 1, scopes: {} };
    }
    return result.data;
  } catch {
    return { version: 1, scopes: {} };
  }
}

function writeStore(store) {
  ensureStorage();
  fs.writeFileSync(STORAGE_FILE, JSON.stringify(store, null, 2), 'utf8');
}

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function resolveScope(req) {
  const userId = String(req.headers['x-wr-user-id'] || 'mock-user');
  const organizationId = String(req.headers['x-wr-org-id'] || 'mock-org');
  const authMode = String(req.headers['x-wr-auth-mode'] || 'local');
  const scopeKey = `${organizationId}::${userId}`;

  return {
    scopeKey,
    userId,
    organizationId,
    authMode,
  };
}

function getScopedState(store, scopeKey) {
  if (!store.scopes[scopeKey]) {
    store.scopes[scopeKey] = {
      workspaces: [],
      autosave: null,
      updatedAt: new Date().toISOString(),
    };
  }

  return store.scopes[scopeKey];
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WR-User-Id, X-WR-Org-Id, X-WR-Auth-Mode',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

// Non-blocking response schema assertion for dev-time bug detection.
// Logs a warning on mismatch but does not alter the response — legacy test data
// (patients without patientNo, without sync, etc.) will surface as warnings.
function warnIfInvalid(schema, data, context) {
  const result = schema.safeParse(data);
  if (!result.success) {
    console.warn(`[mock-intranet] Response schema mismatch (${context}):`,
      result.error.issues.slice(0, 3).map(i => `${i.path.join('.')}: ${i.message}`));
  }
}

function notFound(res) {
  sendJson(res, 404, {
    error: { message: 'Mock intranet route not found.' },
  });
}

function methodNotAllowed(res, allowed) {
  sendJson(res, 405, {
    error: { message: `Method not allowed. Use ${allowed}.` },
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 10 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
      }
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });

    req.on('error', reject);
  });
}

function createWorkspaceItem(name, patients, existingId = null) {
  return {
    id: existingId || `ws_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    count: patients.length,
    savedAt: new Date().toISOString(),
    patients: cloneJson(patients),
  };
}

async function handleWorkspaces(req, res, url) {
  const store = readStore();
  const scope = resolveScope(req);
  const state = getScopedState(store, scope.scopeKey);

  if (req.method === 'GET' && url.pathname === '/api/workspaces') {
    const payload = { items: cloneJson(state.workspaces), mock: true, scope };
    warnIfInvalid(GetWorkspacesResponseSchema, payload, 'GET /api/workspaces');
    sendJson(res, 200, payload);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/workspaces') {
    const body = await readJsonBody(req);
    const parsed = SaveWorkspaceRequestSchema.safeParse(body);

    if (!parsed.success) {
      const first = parsed.error.issues[0];
      sendJson(res, 400, {
        error: { message: first?.message ?? 'Invalid request body.', issues: parsed.error.issues },
      });
      return;
    }

    const { name, patients } = parsed.data;
    const existing = state.workspaces.find(item => item.name === name);
    const nextItem = createWorkspaceItem(name, patients, existing?.id ?? null);

    if (existing) {
      state.workspaces = state.workspaces.map(item => (
        item.id === existing.id ? nextItem : item
      ));
    } else {
      state.workspaces = [...state.workspaces, nextItem];
    }

    state.autosave = null;
    state.updatedAt = new Date().toISOString();
    writeStore(store);

    const postPayload = { items: cloneJson(state.workspaces), mock: true, scope };
    warnIfInvalid(GetWorkspacesResponseSchema, postPayload, 'POST /api/workspaces');
    sendJson(res, 200, postPayload);
    return;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/workspaces/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/workspaces/'.length));
    state.workspaces = state.workspaces.filter(item => String(item.id) !== id);
    state.updatedAt = new Date().toISOString();
    writeStore(store);

    const deletePayload = { items: cloneJson(state.workspaces), mock: true, scope };
    warnIfInvalid(GetWorkspacesResponseSchema, deletePayload, 'DELETE /api/workspaces/:id');
    sendJson(res, 200, deletePayload);
    return;
  }

  if (url.pathname === '/api/workspaces') {
    methodNotAllowed(res, 'GET or POST');
    return;
  }

  if (url.pathname.startsWith('/api/workspaces/')) {
    methodNotAllowed(res, 'DELETE');
    return;
  }

  notFound(res);
}

async function handleAutoSave(req, res, url) {
  const store = readStore();
  const scope = resolveScope(req);
  const state = getScopedState(store, scope.scopeKey);

  if (req.method === 'GET') {
    const getPayload = state.autosave ? { ...cloneJson(state.autosave), mock: true, scope } : null;
    warnIfInvalid(GetAutosaveResponseSchema, getPayload, 'GET /api/autosave');
    sendJson(res, 200, getPayload);
    return;
  }

  if (req.method === 'PUT') {
    const body = await readJsonBody(req);
    const parsed = PutAutosaveRequestSchema.safeParse(body);

    if (!parsed.success) {
      const first = parsed.error.issues[0];
      sendJson(res, 400, {
        error: { message: first?.message ?? 'Invalid request body.', issues: parsed.error.issues },
      });
      return;
    }

    const { patients } = parsed.data;
    state.autosave = {
      savedAt: new Date().toISOString(),
      patients: cloneJson(patients),
    };
    state.updatedAt = new Date().toISOString();
    writeStore(store);

    const putPayload = { ok: true, savedAt: state.autosave.savedAt, mock: true, scope };
    warnIfInvalid(PutAutosaveResponseSchema, putPayload, 'PUT /api/autosave');
    sendJson(res, 200, putPayload);
    return;
  }

  if (req.method === 'DELETE') {
    state.autosave = null;
    state.updatedAt = new Date().toISOString();
    writeStore(store);

    const deletePayload = { ok: true, mock: true, scope };
    warnIfInvalid(DeleteAutosaveResponseSchema, deletePayload, 'DELETE /api/autosave');
    sendJson(res, 200, deletePayload);
    return;
  }

  methodNotAllowed(res, 'GET, PUT, or DELETE');
}

function handleAnalyzeMock(req, res) {
  if (req.method !== 'POST') {
    methodNotAllowed(res, 'POST');
    return;
  }

  sendJson(res, 501, {
    error: {
      message: 'Mock intranet server does not implement AI analysis. The frontend should fall back to /api/analyze.',
    },
    mock: true,
  });
}

function handleStatus(req, res) {
  const store = readStore();
  const scope = resolveScope(req);
  const state = getScopedState(store, scope.scopeKey);

  sendJson(res, 200, {
    ok: true,
    mock: true,
    port: PORT,
    scope,
    workspaceCount: state.workspaces.length,
    hasAutosave: Boolean(state.autosave),
    storageFile: STORAGE_FILE,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);

  if (req.method === 'OPTIONS') {
    sendJson(res, 200, { ok: true });
    return;
  }

  try {
    if (url.pathname === '/api/mock/status') {
      handleStatus(req, res);
      return;
    }

    if (url.pathname === '/api/analyze') {
      handleAnalyzeMock(req, res);
      return;
    }

    if (url.pathname === '/api/autosave') {
      await handleAutoSave(req, res, url);
      return;
    }

    if (url.pathname === '/api/workspaces' || url.pathname.startsWith('/api/workspaces/')) {
      await handleWorkspaces(req, res, url);
      return;
    }

    notFound(res);
  } catch (error) {
    console.error('[mock-intranet] Request failed:', error);
    sendJson(res, 500, {
      error: {
        message: error.message || 'Mock intranet server error.',
      },
      mock: true,
    });
  }
});

server.listen(PORT, () => {
  ensureStorage();
  console.log(`[mock-intranet] Listening on http://localhost:${PORT}`);
  console.log(`[mock-intranet] Storage file: ${STORAGE_FILE}`);
});
