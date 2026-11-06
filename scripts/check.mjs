#!/usr/bin/env node
// `npm run check` — run the local pre-merge checks in one go (REFACTORING_ROADMAP P0-1 / D9).
//
// CI is deferred (D9), so this bundles the checks that were run by hand before a merge.
// It adds no new checks. Every step runs even if an earlier one fails (so one run shows
// everything that is broken), except step 0: without fresh shared builds the later
// type checks and tests would run against missing or stale dist files.
//
// Real-Postgres integration tests and the Python unit tests run in `npm run check:full`
// (scripts/check-full.mjs), which starts a throwaway database. Steps: scripts/lib/runSteps.mjs.
import { installAbortHandlers, printSummary, runCheckSteps } from './lib/runSteps.mjs';

installAbortHandlers();
process.exit(printSummary('check', await runCheckSteps()));
