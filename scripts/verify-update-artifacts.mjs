#!/usr/bin/env node
/**
 * scripts/verify-update-artifacts.mjs
 *
 * Security gate for scripts/export-offline-package.ps1 (계획서 트랙 2, B-5).
 * Parses an electron-builder update metadata file (latest.yml / canary.yml) with
 * a real YAML parser (not a regex), picks the .exe entry explicitly, verifies its
 * SHA-512 against the metadata, guards against path traversal in the `url` field,
 * and confirms the matching .blockmap exists. On success prints a structured JSON
 * result to stdout (consumed by PowerShell via ConvertFrom-Json); on any failure
 * exits non-zero with a message on stderr — the caller must treat that as fatal,
 * not a warning, since this is the check that stops a mismatched
 * installer+metadata pair from being shipped into an air-gapped package.
 *
 * Usage:
 *   node scripts/verify-update-artifacts.mjs --artifact-dir <dir> --metadata-file <latest.yml|canary.yml>
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import yaml from 'js-yaml';

export function pickExeEntry(files) {
  if (!Array.isArray(files)) throw new Error('metadata files[] is missing or not an array');
  const entry = files.find((f) => typeof f?.url === 'string' && f.url.toLowerCase().endsWith('.exe'));
  if (!entry) throw new Error('no .exe entry found in metadata files[]');
  return entry;
}

// Rejects anything that isn't a bare filename in the same directory — no path
// separators, no traversal, before or after URL-decoding.
export function resolveSafeInstallerName(rawUrl) {
  let decoded;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    throw new Error(`url is not validly URL-encoded: ${rawUrl}`);
  }
  if (decoded !== path.basename(decoded) || decoded.includes('..')) {
    throw new Error(`url resolves outside the artifact directory: ${rawUrl}`);
  }
  return decoded;
}

export function verifyUpdateArtifacts({ artifactDir, metadataFileName }) {
  const metadataPath = path.join(artifactDir, metadataFileName);
  if (!existsSync(metadataPath)) throw new Error(`metadata file not found: ${metadataPath}`);

  const metadata = yaml.load(readFileSync(metadataPath, 'utf-8'));
  if (!metadata || typeof metadata !== 'object') throw new Error(`metadata file is not a valid YAML object: ${metadataPath}`);

  const entry = pickExeEntry(metadata.files);
  const installerFile = resolveSafeInstallerName(entry.url);
  const installerPath = path.join(artifactDir, installerFile);
  if (!existsSync(installerPath)) throw new Error(`installer referenced by ${metadataFileName} not found: ${installerPath}`);

  const actualSha512 = createHash('sha512').update(readFileSync(installerPath)).digest('base64');
  if (actualSha512 !== entry.sha512) {
    throw new Error(
      `SHA-512 mismatch for ${installerFile}\n  metadata: ${entry.sha512}\n  actual:   ${actualSha512}\n` +
      `(release/ 안에 이전 빌드 잔여물이 남아 최신 설치본과 오래된 ${metadataFileName}이 잘못 짝지어졌을 가능성)`
    );
  }

  const blockmapFile = `${installerFile}.blockmap`;
  const blockmapPath = path.join(artifactDir, blockmapFile);
  if (!existsSync(blockmapPath)) throw new Error(`blockmap not found next to installer: ${blockmapPath}`);

  return {
    channel: metadataFileName.replace(/\.ya?ml$/i, ''),
    version: metadata.version ?? null,
    metadataFile: metadataFileName,
    installerFile,
    blockmapFile,
    sha512Verified: true,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined; };
  const artifactDir = get('--artifact-dir');
  const metadataFileName = get('--metadata-file');

  if (!artifactDir || !metadataFileName) {
    console.error('Usage: node scripts/verify-update-artifacts.mjs --artifact-dir <dir> --metadata-file <latest.yml|canary.yml>');
    process.exit(1);
  }

  try {
    const result = verifyUpdateArtifacts({ artifactDir, metadataFileName });
    console.log(JSON.stringify(result));
    process.exit(0);
  } catch (err) {
    console.error(`[verify-update-artifacts] FAILED: ${err.message}`);
    process.exit(1);
  }
}

// Only run as CLI when invoked directly (not when imported by tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
