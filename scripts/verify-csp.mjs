#!/usr/bin/env node
/**
 * scripts/verify-csp.mjs
 *
 * Verifies CSP, CORS, and security headers on a running server instance.
 * Run against the real Express server (Docker or local); the mock server is
 * intentionally minimal and does not set these headers.
 *
 * Usage:
 *   node scripts/verify-csp.mjs [--url <base>] [--origin <allowed-origin>]
 *   npm run verify:csp -- --url http://localhost:3001 --origin http://localhost:5173
 *   npm run verify:csp -- --url https://wr.hospital.local --origin https://wr.hospital.local
 *
 * --origin enables two additional CORS checks:
 *   1. Allowed origin receives ACAO echo + Access-Control-Allow-Credentials: true
 *   2. OPTIONS preflight for PUT + If-Match/Idempotency-Key returns correct headers
 *
 * Exit codes: 0 = all checks passed, 1 = failures, 2 = connection error.
 */

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = (urlIdx !== -1 ? args[urlIdx + 1] : args.find(a => !a.startsWith('--')))
  ?.replace(/\/$/, '')
  ?? 'http://localhost:3001';

const originIdx = args.indexOf('--origin');
const ALLOWED_ORIGIN = originIdx !== -1 ? args[originIdx + 1] : null;

// Unauthenticated endpoint present on every deployment — safe to probe.
const PROBE = `${BASE}/api/config/public`;

// ---------------------------------------------------------------------------
// Result tracking
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;

function ok(label) {
  console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  passed++;
}

function fail(label, detail = '') {
  console.error(`  \x1b[31m✗\x1b[0m ${label}${detail ? `\n      ${detail}` : ''}`);
  failed++;
}

function section(title) {
  console.log(`\n\x1b[1m[${title}]\x1b[0m`);
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function probe(extraHeaders = {}) {
  return fetch(PROBE, { headers: extraHeaders });
}

// ---------------------------------------------------------------------------
// 1. Content-Security-Policy
// ---------------------------------------------------------------------------
async function checkCSP() {
  section('CSP');
  const res = await probe();
  const csp = res.headers.get('content-security-policy') ?? '';

  if (!csp) {
    fail('Content-Security-Policy header is present', '(header missing)');
    return;
  }

  // Parse directives into a map for exact checks.
  const directives = Object.fromEntries(
    csp.split(';')
      .map(d => d.trim().split(/\s+/))
      .filter(p => p.length >= 1 && p[0])
      .map(([name, ...vals]) => [name.toLowerCase(), vals])
  );

  function has(directive, ...tokens) {
    const vals = directives[directive] ?? [];
    return tokens.every(t => vals.includes(t));
  }

  const checks = [
    ["default-src 'self'",         has('default-src', "'self'")],
    ["connect-src 'self'",         has('connect-src', "'self'")],
    ["script-src 'self'",          has('script-src', "'self'")],
    ["img-src includes blob:",     has('img-src', 'blob:')],
    ["worker-src includes blob:",  has('worker-src', 'blob:')],
    ["frame-ancestors 'none'",     has('frame-ancestors', "'none'")],
  ];

  // connect-src must NOT include wildcard or external origins
  const connectSrc = directives['connect-src'] ?? [];
  const connectSrcClean = !connectSrc.includes('*') && !connectSrc.some(v => v.startsWith('http') && !v.startsWith("'self'"));
  checks.push(["connect-src has no external origins", connectSrcClean]);

  // script-src must NOT include 'unsafe-inline' or 'unsafe-eval'
  const scriptSrc = directives['script-src'] ?? [];
  checks.push(["script-src has no 'unsafe-inline'", !scriptSrc.includes("'unsafe-inline'")]);
  checks.push(["script-src has no 'unsafe-eval'",   !scriptSrc.includes("'unsafe-eval'")]);

  for (const [label, pass] of checks) {
    if (pass) ok(label);
    else fail(label, `CSP value: ${csp}`);
  }
}

// ---------------------------------------------------------------------------
// 2. CORS
// ---------------------------------------------------------------------------
async function checkCORS() {
  section('CORS');

  // Origins that must always be blocked (403 CORS_ORIGIN_DENIED).
  const blockedOrigins = [
    'null',
    'file://',
    'app://',
    'https://evil.example.com',
    'https://attacker.hospital.local',
  ];

  for (const origin of blockedOrigins) {
    const res = await probe({ Origin: origin });
    if (res.status === 403) {
      ok(`blocks origin: ${origin}`);
    } else {
      fail(`blocks origin: ${origin}`, `got HTTP ${res.status}`);
    }
  }

  // Same-origin (no Origin header) must always be allowed.
  const sameOriginRes = await probe();
  if (sameOriginRes.ok) {
    ok('allows same-origin request (no Origin header)');
  } else {
    fail('allows same-origin request (no Origin header)', `got HTTP ${sameOriginRes.status}`);
  }

  if (!ALLOWED_ORIGIN) {
    console.log('  \x1b[33m(skip)\x1b[0m allowed-origin + preflight checks require --origin <url>');
    console.log(`        e.g. npm run verify:csp -- --url ${BASE} --origin http://localhost:5173`);
    return;
  }

  // Allowed origin: must echo ACAO + Access-Control-Allow-Credentials: true.
  const allowedRes = await probe({ Origin: ALLOWED_ORIGIN });
  const acao = allowedRes.headers.get('access-control-allow-origin');
  const acac = allowedRes.headers.get('access-control-allow-credentials');
  if (allowedRes.ok && acao === ALLOWED_ORIGIN) {
    ok(`allows origin: ${ALLOWED_ORIGIN} (ACAO echoed)`);
  } else {
    fail(`allows origin: ${ALLOWED_ORIGIN} (ACAO echoed)`,
      `status=${allowedRes.status}, Access-Control-Allow-Origin: ${acao}`);
  }
  if (acac === 'true') {
    ok('Access-Control-Allow-Credentials: true for allowed origin');
  } else {
    fail('Access-Control-Allow-Credentials: true for allowed origin', `got: ${acac}`);
  }

  // OPTIONS preflight: PUT method + T40 custom headers must be allowed.
  const preflightRes = await fetch(PROBE, {
    method: 'OPTIONS',
    headers: {
      Origin:                          ALLOWED_ORIGIN,
      'Access-Control-Request-Method': 'PUT',
      'Access-Control-Request-Headers': 'if-match,idempotency-key,x-csrf-token',
    },
  });
  const allowMethods = (preflightRes.headers.get('access-control-allow-methods') ?? '').toUpperCase();
  if (preflightRes.status < 400 && allowMethods.includes('PUT')) {
    ok('preflight: PUT in Access-Control-Allow-Methods');
  } else {
    fail('preflight: PUT in Access-Control-Allow-Methods',
      `status=${preflightRes.status}, methods=${allowMethods}`);
  }
  const allowHeaders = (preflightRes.headers.get('access-control-allow-headers') ?? '').toLowerCase();
  for (const h of ['if-match', 'idempotency-key', 'x-csrf-token']) {
    if (allowHeaders.includes(h)) {
      ok(`preflight: ${h} in Access-Control-Allow-Headers`);
    } else {
      fail(`preflight: ${h} in Access-Control-Allow-Headers`, `got: ${allowHeaders}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Security headers (helmet defaults)
// ---------------------------------------------------------------------------
async function checkSecurityHeaders() {
  section('Security Headers');
  const res = await probe();

  const checks = [
    ['X-Content-Type-Options: nosniff',
      res.headers.get('x-content-type-options') === 'nosniff'],
    ['X-Frame-Options present',
      !!res.headers.get('x-frame-options')],
    ['X-DNS-Prefetch-Control present',
      !!res.headers.get('x-dns-prefetch-control')],
    ['Referrer-Policy present',
      !!res.headers.get('referrer-policy')],
    ['X-Permitted-Cross-Domain-Policies present',
      !!res.headers.get('x-permitted-cross-domain-policies')],
  ];

  for (const [label, pass] of checks) {
    if (pass) ok(label);
    else fail(label, `header missing`);
  }
}

// ---------------------------------------------------------------------------
// 4. blob: UX smoke-check note
// ---------------------------------------------------------------------------
function printBlobNote() {
  section('blob: manual check reminder');
  console.log('  This script cannot automate blob: URL behavior (requires a browser).');
  console.log('  Manually verify:');
  console.log('    - PDF export (html2pdf) creates a blob: download link');
  console.log('    - Excel export creates a blob: download link');
  console.log('    - Image previews load via blob: URL');
  console.log('    - Web Worker (if any) loads from blob: or same-origin');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log(`\nVerifying CSP/CORS/security headers at \x1b[1m${BASE}\x1b[0m`);

try {
  // Connectivity check
  const ping = await fetch(PROBE).catch(e => { throw new Error(`Cannot reach server: ${e.message}`); });
  if (!ping.ok && ping.status !== 401 && ping.status !== 403) {
    console.warn(`  Warning: probe endpoint returned HTTP ${ping.status}`);
  }

  await checkCSP();
  await checkCORS();
  await checkSecurityHeaders();
  printBlobNote();
} catch (err) {
  console.error(`\n\x1b[31mConnection error:\x1b[0m ${err.message}`);
  console.error(`Make sure the server is running at ${BASE}`);
  process.exit(2);
}

console.log(`\n${'─'.repeat(50)}`);
if (failed === 0) {
  console.log(`\x1b[32m✓ All ${passed} checks passed.\x1b[0m\n`);
} else {
  console.log(`\x1b[31m✗ ${failed} check(s) failed\x1b[0m, ${passed} passed.\n`);
}
process.exit(failed > 0 ? 1 : 0);
