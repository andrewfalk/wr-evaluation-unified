// TargetPicker가 TS로 옮겨질 때 지운다(임시 타입 선언, P2-75b-ts) — TargetPicker.jsx는 구조분해 기본값(frameUrl = null)으로
// prop 타입을 null로 좁혀 추론해, 썸네일 주소(string)를 넘기는 TS 호출부(VideoAnalysisStep.tsx)가 붙지 않는다.
// 구현(JS)은 그대로이고, 구현이 읽는 모양만 적는다.
import type { NamedExoticComponent } from 'react';

export interface DetectedPerson {
  id: string;
  /** xywh 픽셀(sample-detect 계약). */
  bbox: [number, number, number, number];
}

export interface SampleDetectResult {
  frameWidth: number;
  frameHeight?: number;
  persons?: DetectedPerson[];
}

export function scaledCandidates(
  result: SampleDetectResult | null | undefined,
  maxWidth?: number,
): { width: number; height: number; scale: number; boxes: Array<{ id: string; x: number; y: number; w: number; h: number }> };

export interface TargetPickerProps {
  result: SampleDetectResult | null | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  frameUrl?: string | null;
}

export const TargetPicker: NamedExoticComponent<TargetPickerProps>;
