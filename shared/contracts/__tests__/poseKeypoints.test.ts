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
