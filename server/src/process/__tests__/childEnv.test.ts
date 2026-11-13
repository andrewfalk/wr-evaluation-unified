// SEC-A L10 (P1-22): what a Python child process gets from the server environment — key sets only.
import { describe, expect, it } from 'vitest';
import { buildChildEnv, isAllowedChildEnvKey } from '../childEnv';

const SERVER_ENV: NodeJS.ProcessEnv = {
  // secrets and server settings — never passed on
  DATABASE_URL: 'postgres://wr_app:secret@postgres:5432/wr_evaluation',
  AUDIT_DATABASE_URL: 'postgres://wr_audit_reader:secret@postgres:5432/wr_evaluation',
  ACCESS_TOKEN_SECRET: 'x'.repeat(64),
  AI_EXTERNAL_API_KEY: 'sk-test',
  AI_EXTERNAL_ENDPOINT: 'https://example.invalid',
  BACKUP_GPG_RECIPIENT: 'someone@example.invalid',
  CORS_ORIGINS: 'https://example.invalid',
  NODE_ENV: 'production',
  QUEUE_NAMESPACE: 'default',
  VIDEO_ANALYSIS_UPLOAD_DIR: '/app/.video-uploads',
  STATS_ENGINE_PYTHON: '/opt/stats-venv/bin/python',
  // allowed
  Path: 'C:\\Windows;C:\\CUDA\\bin', // Windows spelling
  SystemRoot: 'C:\\Windows',
  TEMP: 'C:\\Temp',
  HOME: '/home/node',
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TZ: 'UTC',
  PYTHONIOENCODING: 'utf-8',
  CUDA_PATH: 'C:\\CUDA',
  CUDA_VISIBLE_DEVICES: '0',
  NVIDIA_VISIBLE_DEVICES: 'all',
  LD_LIBRARY_PATH: '/usr/local/cuda/lib64',
  ORT_DISABLE_TELEMETRY: '1',
  ONNXRUNTIME_PROVIDER: 'cuda',
  POSE_MODELS_DIR: '/app/pose-inference/models',
  OMP_NUM_THREADS: '4',
};

describe('buildChildEnv (SEC-A L10)', () => {
  it('passes on only the OS, Python, GPU / ONNX Runtime and thread variables — never a secret or server setting', () => {
    expect(Object.keys(buildChildEnv({}, SERVER_ENV)).sort()).toEqual([
      'CUDA_PATH', 'CUDA_VISIBLE_DEVICES', 'HOME', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'NVIDIA_VISIBLE_DEVICES',
      'OMP_NUM_THREADS', 'ONNXRUNTIME_PROVIDER', 'ORT_DISABLE_TELEMETRY', 'POSE_MODELS_DIR', 'PYTHONIOENCODING',
      'Path', 'SystemRoot', 'TEMP', 'TZ',
    ]);
  });

  it('keeps the original spelling and value of an allowed key (Windows Path)', () => {
    expect(buildChildEnv({}, SERVER_ENV).Path).toBe(SERVER_ENV.Path);
    expect(isAllowedChildEnvKey('Path')).toBe(true);
    expect(isAllowedChildEnvKey('path')).toBe(true);
  });

  it('adds the caller\'s variables on top, and undefined removes one', () => {
    const env = buildChildEnv({ OMP_NUM_THREADS: '1', STATS_ENGINE_TIMING: '1', TZ: undefined }, SERVER_ENV);
    expect(env.OMP_NUM_THREADS).toBe('1');
    expect(env.STATS_ENGINE_TIMING).toBe('1');
    expect(env).not.toHaveProperty('TZ');
  });

  it('no secret-looking key slips through a prefix', () => {
    for (const key of ['DATABASE_URL', 'ACCESS_TOKEN_SECRET', 'AI_EXTERNAL_API_KEY', 'POSTGRES_PASSWORD', 'PGPASSWORD',
      'AUDIT_DB_PASSWORD', 'APP_DB_PASSWORD', 'OWNER_DB_PASSWORD', 'NODE_OPTIONS', 'PYTHONPATH', 'PYTHONSTARTUP']) {
      expect([key, isAllowedChildEnvKey(key)]).toEqual([key, false]);
    }
  });
});
