// SEC-A L10 (P1-22): the environment a Python child process gets. Children used to inherit the whole server
// environment — DATABASE_URL (with its password), ACCESS_TOKEN_SECRET, AI API keys — although none of the analysis
// scripts needs any of it. Only what the OS, the Python runtime, the GPU / ONNX Runtime stack and the thread knobs
// need is passed on, plus what the caller adds.
//
// Reads process.env directly (lint exception like the config module): it is the one place that decides what leaves
// the server process.

/** Variables passed on by exact name (compared case-insensitively — Windows spells PATH as `Path`). */
const EXACT = new Set([
  // OS / process basics (Windows and POSIX)
  'PATH', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE',
  'LANG', 'LANGUAGE', 'TZ',
  // Python runtime
  'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONHASHSEED',
  // shared libraries (CUDA / cuDNN on Linux)
  'LD_LIBRARY_PATH',
  // pose models folder (server/Dockerfile ENV; services/pose-inference/model_loader.py)
  'POSE_MODELS_DIR',
  // thread knobs
  'OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS', 'VECLIB_MAXIMUM_THREADS',
]);

/** Variables passed on by prefix: locale, CUDA / NVIDIA container runtime, ONNX Runtime (`ORT_DISABLE_TELEMETRY`). */
const PREFIXES = ['LC_', 'CUDA_', 'NVIDIA_', 'ONNXRUNTIME_', 'ORT_'];

export function isAllowedChildEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  return EXACT.has(upper) || PREFIXES.some((p) => upper.startsWith(p));
}

/**
 * The allowed subset of `source` (default: this process's environment), then `extra` on top. An `extra` value of
 * `undefined` removes the key.
 */
export function buildChildEnv(
  extra: Record<string, string | undefined> = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedChildEnvKey(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}
