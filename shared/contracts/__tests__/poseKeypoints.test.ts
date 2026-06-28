import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PoseKeypointsSchema } from '../poseKeypoints';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// services/pose-inference/fixtures/keypoints.sample.json (synthetic, committed)
const fixturePath = path.resolve(__dirname, '../../../services/pose-inference/fixtures/keypoints.sample.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));

describe('PoseKeypointsSchema — drift guard', () => {
  it('validates the committed synthetic fixture (Python 산출 형태와 동일 계약)', () => {
    const r = PoseKeypointsSchema.parse(fixture);
    expect(r.keypointConvention).toBe('coco17');
    expect(r.frames.length).toBeGreaterThan(0);
  });

  it('enforces 17 keypoints for coco17 (superRefine)', () => {
    const bad = structuredClone(fixture);
    bad.frames[1].persons[0].keypoints = bad.frames[1].persons[0].keypoints.slice(0, 16);
    expect(() => PoseKeypointsSchema.parse(bad)).toThrow(/17 keypoints/);
  });

  it('rejects a keypoint that is not [x,y,score]', () => {
    const bad = structuredClone(fixture);
    bad.frames[1].persons[0].keypoints[0] = [1, 2];
    expect(() => PoseKeypointsSchema.parse(bad)).toThrow();
  });

  it('rejects bbox that is not length-4 (or null)', () => {
    const bad = structuredClone(fixture);
    bad.frames[1].persons[0].bbox = [1, 2, 3];
    expect(() => PoseKeypointsSchema.parse(bad)).toThrow();
  });

  it('allows null bbox / null trackId (PoC: no detection / no tracking)', () => {
    const ok = structuredClone(fixture);
    ok.frames[1].persons[0].bbox = null;
    ok.frames[1].persons[0].trackId = null;
    expect(() => PoseKeypointsSchema.parse(ok)).not.toThrow();
  });

  it('rejects unknown schemaVersion / missing model field', () => {
    expect(() => PoseKeypointsSchema.parse({ ...fixture, schemaVersion: 2 })).toThrow();
    const noModel = structuredClone(fixture);
    delete noModel.model;
    expect(() => PoseKeypointsSchema.parse(noModel)).toThrow();
  });

  it('rejects extra fields (strict — matches JSON Schema additionalProperties:false)', () => {
    expect(() => PoseKeypointsSchema.parse({ ...fixture, surprise: 1 })).toThrow();
    const extraPerson = structuredClone(fixture);
    extraPerson.frames[1].persons[0].surprise = 1;
    expect(() => PoseKeypointsSchema.parse(extraPerson)).toThrow();
  });

  it('rejects confidence score outside 0..1', () => {
    const badKp = structuredClone(fixture);
    badKp.frames[1].persons[0].keypoints[0][2] = 1.5;
    expect(() => PoseKeypointsSchema.parse(badKp)).toThrow();
    const badPerson = structuredClone(fixture);
    badPerson.frames[1].persons[0].score = 1.5;
    expect(() => PoseKeypointsSchema.parse(badPerson)).toThrow();
  });
});

describe('PoseKeypointsSchema — model weight sha / recipe (6.0-9)', () => {
  const sha = 'a'.repeat(64);

  it('fixture는 미반입(PoC): sha=null + weightsComplete=false', () => {
    const r = PoseKeypointsSchema.parse(fixture);
    expect(r.model.detectorSha256).toBeNull();
    expect(r.model.poseSha256).toBeNull();
    expect(r.model.weightsComplete).toBe(false);
  });

  it('verified(weightsComplete=true)면 두 sha 모두 64-hex 필수 — null이면 거부', () => {
    const verified = structuredClone(fixture);
    verified.model.weightsComplete = true;
    verified.model.detectorSha256 = sha;
    verified.model.poseSha256 = sha;
    expect(() => PoseKeypointsSchema.parse(verified)).not.toThrow();

    const missingPose = structuredClone(verified);
    missingPose.model.poseSha256 = null;
    expect(() => PoseKeypointsSchema.parse(missingPose)).toThrow();
  });

  it('sha는 소문자 64-hex만 허용(잘못된 길이/대문자 거부)', () => {
    const badLen = structuredClone(fixture);
    badLen.model.detectorSha256 = 'abc123';
    expect(() => PoseKeypointsSchema.parse(badLen)).toThrow();
    const upper = structuredClone(fixture);
    upper.model.poseSha256 = 'A'.repeat(64);
    expect(() => PoseKeypointsSchema.parse(upper)).toThrow();
  });

  it('model 신규 필드 누락(weightsComplete) 거부 — strict drift guard', () => {
    const noFlag = structuredClone(fixture);
    delete noFlag.model.weightsComplete;
    expect(() => PoseKeypointsSchema.parse(noFlag)).toThrow();
  });

  // 6.0-12: 추론 디바이스 필드. JSON Schema와 Zod 미러가 모두 알고 있어야 overlay safeParse가 새 artifact를 통과시킨다.
  it('추론 디바이스 필드(requestedDevice/deviceUsed/deviceFallback/fallbackReason)를 허용한다', () => {
    const r = PoseKeypointsSchema.parse(fixture); // fixture에 device 필드 포함
    expect(r.model.requestedDevice).toBe('auto');
    expect(r.model.deviceUsed).toBe('cpu');
    expect(r.model.deviceFallback).toBe(false);
    expect(r.model.fallbackReason).toBeNull();
  });

  it('device 필드 부재(구 artifact)도 허용 — optional 하위호환', () => {
    const legacy = structuredClone(fixture);
    delete legacy.model.requestedDevice;
    delete legacy.model.deviceUsed;
    delete legacy.model.deviceFallback;
    delete legacy.model.fallbackReason;
    expect(() => PoseKeypointsSchema.parse(legacy)).not.toThrow();
  });

  it('잘못된 deviceUsed 값(auto/임의문자열)은 거부', () => {
    const bad = structuredClone(fixture);
    bad.model.deviceUsed = 'auto'; // deviceUsed는 실행 결과라 cpu|cuda만(auto 금지)
    expect(() => PoseKeypointsSchema.parse(bad)).toThrow();
  });
});

describe('PoseKeypointsSchema — quality meta (PR D3a, §8.8)', () => {
  const validQuality = { blurMetric: { mean: 120, p10: 40, median: 110 }, dropRatio: 0.02, sampledFps: 2 };

  it('accepts optional quality + threshold-derived fields', () => {
    const r = PoseKeypointsSchema.parse({ ...fixture, quality: { ...validQuality, blurThreshold: 100, blurRatio: 0.1, usableFrameRatio: 0.88 } });
    expect(r.quality?.blurMetric.mean).toBe(120);
  });

  it('allows omitting quality (PR B/C/D2 하위호환)', () => {
    expect(PoseKeypointsSchema.parse(fixture).quality).toBeUndefined();
  });

  it('rejects quality with out-of-range ratio, missing blurMetric, or extra field (strict)', () => {
    expect(() => PoseKeypointsSchema.parse({ ...fixture, quality: { ...validQuality, dropRatio: 2 } })).toThrow();
    expect(() => PoseKeypointsSchema.parse({ ...fixture, quality: { dropRatio: 0.1, sampledFps: 2 } })).toThrow(); // blurMetric 누락
    expect(() => PoseKeypointsSchema.parse({ ...fixture, quality: { ...validQuality, surprise: 1 } })).toThrow();
  });
});
