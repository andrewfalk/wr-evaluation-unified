#!/usr/bin/env node
// `npm run check:full` — everything in `npm run check`, plus the tests that need real services
// (REFACTORING_ROADMAP P0-10 / P0-2 / P0-12, D9). Use it for PRs that touch the database,
// concurrency, the stats engine or migrations, and before a release.
//
//   0. Preconditions: Docker is running; the stats-engine venv has numpy, scipy, jsonschema, pytest.
//   1. A throwaway PostgreSQL (postgres:16-alpine, same as production) in a container: loopback
//      only, a random host port, data on tmpfs, a fresh random password (never printed), database
//      `wr_test`. It never touches the development database or any real data, and it is removed
//      at the end — also on failure or Ctrl+C. If a run is killed outright, the next run removes
//      its container (labelled with the run's process id).
//   2. `npm run check` (all steps) with the venv's Python forced on, so the Python smoke tests
//      cannot skip.
//   3. Server integration tests (server/vitest.integration.config.ts) against that database.
//      WR_REQUIRE_INTEGRATION=1 turns a missing database into a failure instead of a skip.
//   4. Python unit tests (pytest) in services/stats-engine with the production versions: an image
//      from services/stats-engine/Dockerfile.test (Debian 12 python3 3.11 + requirements.txt pins,
//      as in server/Dockerfile), built once and reused until those files change. The local venv
//      is still used by the Node<->Python smoke and integration tests in steps 2-3.
//   5. Production-dependency audit (scripts/verify-audit.mjs): fails on a high/critical npm
//      advisory that is not in the reviewed list scripts/audit-allowlist.json. Needs the registry.
//   6. Secret scan (scripts/verify-secrets.mjs, gitleaks in Docker) of the current branch history,
//      including commits not pushed yet.
//
// Not included: building the Docker images — slow, and scripts/export-offline-package.ps1
// already builds and checks them for every release package.
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { installAbortHandlers, isAborted, printSummary, root, runCheckSteps, runStep, skipped } from './lib/runSteps.mjs';

const STATS_DIR = path.join(root, 'services', 'stats-engine');
const PYTHON = path.join(STATS_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');

// Production-version test image for the stats engine, tagged by the content of the files that
// define it, so a changed pin rebuilds it and an unchanged one reuses it.
function statsTestImageTag() {
  const hash = createHash('sha256');
  for (const name of ['Dockerfile.test', 'requirements.txt', 'requirements-dev.txt']) {
    hash.update(name).update('\0').update(readFileSync(path.join(STATS_DIR, name))).update('\0');
  }
  return `wr-stats-test:${hash.digest('hex').slice(0, 12)}`;
}
const IMAGE = 'postgres:16-alpine';
const CONTAINER = `wr-check-pg-${process.pid}`;
const LABEL = 'wr.check-full.pid';

let containerStarted = false;
function removeContainer() {
  if (!containerStarted) return;
  containerStarted = false;
  spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
}
// Cleanup runs in main()'s finally; this 'exit' hook covers a second Ctrl+C (immediate exit).
process.on('exit', removeContainer);
installAbortHandlers();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CheckFullError extends Error {}
function fail(message) {
  throw new CheckFullError(message);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function main() {
  // --- 0. preconditions ------------------------------------------------------------------------
  if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
    fail('Docker is not running. Start Docker Desktop and run `npm run check:full` again.');
  }
  if (!existsSync(PYTHON)) {
    fail(`stats-engine venv not found: ${PYTHON}\n  Create it: python -m venv services/stats-engine/.venv, then install services/stats-engine/requirements.txt and pytest.`);
  }
  if (spawnSync(PYTHON, ['-c', 'import numpy, scipy, jsonschema, pytest'], { stdio: 'ignore' }).status !== 0) {
    fail(`${PYTHON} lacks numpy/scipy/jsonschema/pytest.\n  Install services/stats-engine/requirements.txt and pytest into that venv.`);
  }

  // --- 1. throwaway PostgreSQL -----------------------------------------------------------------
  // A run that was killed outright (closed window, killed process) cannot clean up, and `--rm`
  // only removes a container once it stops. Remove containers left by earlier runs whose
  // process is gone; a concurrent run's container (process still alive) is left alone.
  const leftovers = spawnSync('docker', ['ps', '-a', '--filter', `label=${LABEL}`, '--format', `{{.ID}} {{.Label "${LABEL}"}}`], { encoding: 'utf8' }).stdout ?? '';
  for (const line of leftovers.split('\n').filter(Boolean)) {
    const [id, pid] = line.trim().split(/\s+/);
    if (!processAlive(Number(pid))) {
      process.stdout.write(`removing a container left by an earlier check:full run (pid ${pid})\n`);
      spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
    }
  }

  const password = randomBytes(24).toString('hex');
  process.stdout.write(`\n=== throwaway PostgreSQL: ${IMAGE} as ${CONTAINER}\n`);
  const started = spawnSync('docker', [
    'run', '-d', '--rm', '--name', CONTAINER, '--label', `${LABEL}=${process.pid}`,
    '-e', 'POSTGRES_USER=wr_user',
    '-e', 'POSTGRES_PASSWORD', // value comes from this process's env, not the command line
    '-e', 'POSTGRES_DB=wr_test',
    '--tmpfs', '/var/lib/postgresql/data',
    '-p', '127.0.0.1::5432',
    IMAGE,
  ], { env: { ...process.env, POSTGRES_PASSWORD: password }, encoding: 'utf8' });
  if (started.status !== 0) fail(`could not start ${IMAGE}:\n${started.stderr}`);
  containerStarted = true;

  const portOut = spawnSync('docker', ['port', CONTAINER, '5432/tcp'], { encoding: 'utf8' }).stdout ?? '';
  const port = /127\.0\.0\.1:(\d+)/.exec(portOut)?.[1];
  if (!port) fail(`could not read the published port of ${CONTAINER} (${portOut.trim()})`);

  // TCP readiness inside the container: during first-run init the image's temporary server does
  // not listen on TCP, so this only succeeds once the real server is up. Async wait, so Ctrl+C
  // is handled here too.
  let ready = false;
  for (let i = 0; i < 60 && !ready && !isAborted(); i += 1) {
    ready = spawnSync('docker', ['exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1', '-U', 'wr_user', '-d', 'wr_test'], { stdio: 'ignore' }).status === 0;
    if (!ready) await sleep(1000);
  }
  if (!ready && !isAborted()) fail(`${CONTAINER} did not become ready within 60 s.`);
  if (ready) process.stdout.write(`ready on 127.0.0.1:${port}\n`);

  // --- 2-4. checks (each step is skipped once a signal has been received) ----------------------
  const pythonEnv = {
    STATS_ENGINE_PYTHON_FOR_TEST: PYTHON, // read by the Python smoke tests (default would be PATH `python`)
    STATS_ENGINE_PYTHON: PYTHON,          // the engine the integration tests spawn
    STATS_ENGINE_REQUIRE_PYTHON: '1',     // smoke tests fail instead of skipping without Python
  };
  const results = await runCheckSteps({ env: pythonEnv });
  const sharedBuilt = results[0].ok;

  const integrationEnv = {
    ...pythonEnv,
    TEST_DATABASE_URL: `postgres://wr_user:${password}@127.0.0.1:${port}/wr_test`,
    WR_REQUIRE_INTEGRATION: '1',
  };
  results.push(sharedBuilt
    ? await runStep('integration tests (server, real PostgreSQL)', 'npm --prefix server run test:integration', { env: integrationEnv })
    : skipped('integration tests (server, real PostgreSQL)'));
  const statsImage = statsTestImageTag();
  if (spawnSync('docker', ['image', 'inspect', statsImage], { stdio: 'ignore' }).status === 0) {
    process.stdout.write(`\n=== python test image ${statsImage}: already built, reused\n`);
  } else {
    results.push(await runStep('python test image (production versions)', `docker build -t ${statsImage} -f "${path.join(STATS_DIR, 'Dockerfile.test')}" "${STATS_DIR}"`));
  }
  const imageReady = spawnSync('docker', ['image', 'inspect', statsImage], { stdio: 'ignore' }).status === 0;
  const inImage = (cmd) => `docker run --rm -e PYTHONDONTWRITEBYTECODE=1 -v "${STATS_DIR}:/w:ro" -w /w ${statsImage} /opt/stats-venv/bin/python ${cmd}`;
  if (imageReady) {
    // First print one line with the versions the tests run on (kept in the log), then pytest.
    results.push(await runStep('python unit tests (production versions)',
      `${inImage('-c "import sys,numpy,scipy,statsmodels,pandas;print(sys.version.split()[0],numpy.__version__,scipy.__version__,statsmodels.__version__,pandas.__version__)"')} && ${inImage('-m pytest -q -p no:cacheprovider')}`));
  } else {
    results.push(skipped('python unit tests (production versions)'));
  }
  results.push(await runStep('dependency audit (production, reviewed list)', 'npm run verify:audit'));
  results.push(await runStep('secret scan (gitleaks, git history)', 'npm run verify:secrets'));
  return printSummary('check:full', results);
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  if (!(err instanceof CheckFullError)) throw err;
  process.stderr.write(`\ncheck:full: ${err.message}\n`);
  exitCode = isAborted() ? 130 : 1;
} finally {
  removeContainer();
}
process.exit(exitCode);
