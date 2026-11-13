// GPU probe for the organization inference settings (runs probe_device.py with the video Python).
// Split out of routes/admin.ts (S5 P1-28); handler bodies unchanged.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import config from '../../config';
import { buildChildEnv } from '../../process/childEnv';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// GET/PATCH /api/admin/org-settings — 조직 단위 추론 디바이스 설정(6.0-12).
// GPU 감지는 Node가 직접 못 하므로(추론은 Python venv/컨테이너) config.video.python으로 probe_device.py 실행.
// ---------------------------------------------------------------------------
export async function probeGpu(): Promise<{ cudaAvailable: boolean; providers: string[]; error?: string }> {
  try {
    const script = path.join(config.video.scriptsDir, 'probe_device.py');
    const { stdout } = await execFileAsync(config.video.python, [script], { timeout: 15000, env: buildChildEnv() });
    const parsed = JSON.parse(stdout) as { cudaAvailable?: boolean; providers?: string[] };
    return {
      cudaAvailable: parsed.cudaAvailable === true,
      providers: Array.isArray(parsed.providers) ? parsed.providers : [],
    };
  } catch (err) {
    // onnxruntime 미설치·python 미구성 등 — UI가 "감지 불가"로 표시(분석 자체는 auto가 CPU로 동작).
    return { cudaAvailable: false, providers: [], error: String((err as Error)?.message ?? err).slice(0, 200) };
  }
}
