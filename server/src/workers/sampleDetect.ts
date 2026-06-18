import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SampleDetectResultSchema, type SampleDetectResult } from '@wr/contracts';
import config from '../config';

// ---------------------------------------------------------------------------
// sample-detect 러너 (6.0-6b, PR D2b, §8.7). 대표 프레임 person box 후보 탐지(dev fixture).
// 워커의 defaultRunInference와 형제 — async execFile(promisified) + timeout + tmp cleanup.
// 출력은 SampleDetectResultSchema로 검증(신뢰 경계). execFileSync 금지(이벤트 루프 차단).
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const SAMPLE_DETECT_TIMEOUT_MS = 2 * 60 * 1000;

export async function runSampleDetect(
  clipPath: string,
  opts: { thumbnailPath?: string } = {},
): Promise<SampleDetectResult> {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'va-sd-'));
  try {
    const outPath = path.join(work, 'cand.json');
    const args = [path.join(config.video.scriptsDir, 'sample_detect.py'), '--input', clipPath, '--output', outPath];
    // 정책 예외: 대표 프레임 썸네일 생성(부가기능). Python이 실패해도 JSON은 정상 → 본기능 무영향.
    if (opts.thumbnailPath) args.push('--thumbnail', opts.thumbnailPath);
    await execFileAsync(config.video.python, args, { timeout: SAMPLE_DETECT_TIMEOUT_MS });
    const raw = fs.readFileSync(outPath, 'utf-8');
    // 출력 = 신뢰 경계. JSON/계약 검증 실패는 "깨진 출력"으로 태깅(라우트가 INVALID_SAMPLE_DETECT 명시 응답으로 매핑).
    // timeout/python 크래시 등은 태깅하지 않음 → 일반 내부오류로 남김.
    let parsed: SampleDetectResult;
    try {
      parsed = SampleDetectResultSchema.parse(JSON.parse(raw));
    } catch (err) {
      throw Object.assign(new Error(`sample-detect produced an invalid result: ${String((err as Error)?.message ?? err)}`), {
        code: 'INVALID_SAMPLE_DETECT',
      });
    }
    return parsed;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
