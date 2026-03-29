import { buildSessionHeaders } from '../auth/session';

function normalizeBaseUrl(baseUrl = '') {
  return String(baseUrl || '').trim().replace(/\/$/, '');
}

function buildUrl(baseUrl, path) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) return path;
  return `${normalizedBase}${path}`;
}

export async function requestJson(path, { baseUrl = '', method = 'GET', body, session, headers = {} } = {}) {
  const response = await fetch(buildUrl(baseUrl, path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...buildSessionHeaders(session),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const message = data?.error?.message || `Request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}
