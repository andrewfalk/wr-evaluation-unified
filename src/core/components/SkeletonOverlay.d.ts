// SkeletonOverlay가 TS로 옮겨질 때 지운다(임시 타입 선언, P2-75b-ts) — SkeletonOverlay.jsx는 구조분해 기본값
// (activeSegments = [])으로 prop 타입을 never[]로 좁혀 추론해, 근거 구간을 넘기는 TS 호출부(VideoAnalysisStep.tsx)가 붙지 않는다.
// 구현(JS)은 그대로이고, 구현이 읽는 모양만 적는다.
import type { NamedExoticComponent } from 'react';

export interface OverlaySegment {
  startMs: number;
  endMs: number;
}

export interface OverlayFrame {
  timestampMs?: number;
}

export function trimFrameCache<K>(cache: Map<K, string>, keepIdx: Set<K>, revoke?: (url: string) => void): void;

export const COCO17_BONES: Array<[number, number]>;

export function frameActive(timestampMs: number | null | undefined, segments: OverlaySegment[] | null | undefined): boolean;

export function activeFrameIndices(frames: Array<OverlayFrame | null | undefined> | null | undefined, segments: OverlaySegment[] | null | undefined): number[];

export function scaledKeypoints(
  keypoints: Array<[number, number, number]> | null | undefined,
  meta: { frameWidth?: number; frameHeight?: number; coordinateSpace?: string } | null | undefined,
  maxWidth?: number,
): { width: number; height: number; scale: number; points: Array<{ x: number; y: number; score: number }> };

export interface SkeletonOverlayProps {
  /** 서버 검수 자료(jobId·framesAvailable·targetTrackId·keypoints). */
  overlay: object | null | undefined;
  activeSegments?: OverlaySegment[];
  session?: unknown;
  settings?: unknown;
}

export const SkeletonOverlay: NamedExoticComponent<SkeletonOverlayProps>;
