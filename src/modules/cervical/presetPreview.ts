// 경추 프리셋 미리보기 칩(Phase 2 C7-a FX-3) — 프리셋 관리 창의 작업 카드에 노출 유형·하중·시간을 보인다.
// 표기는 경추 작업 목록(TaskManager.jsx)의 요약과 같은 꼴(`운반 Nh` · `비중립 Nh`)이다. 값이 빈 항목은 칩을 만들지 않는다.
import { EXPOSURE_TYPE_LABELS } from './utils/data';

const isFilled = (value: unknown): boolean => value !== undefined && value !== null && String(value).trim() !== '';

export function cervicalPresetChips(task: Readonly<Record<string, unknown>>): string[] {
  const chips: string[] = [];
  const exposureTypes = Array.isArray(task.exposure_types) ? task.exposure_types : [];
  for (const type of exposureTypes) {
    const key = String(type);
    chips.push(EXPOSURE_TYPE_LABELS[key] || key);
  }
  if (isFilled(task.load_weight_kg)) chips.push(`${String(task.load_weight_kg)}kg`);
  if (isFilled(task.carry_hours_per_shift)) chips.push(`운반 ${String(task.carry_hours_per_shift)}h`);
  if (isFilled(task.neck_nonneutral_hours_per_day)) chips.push(`비중립 ${String(task.neck_nonneutral_hours_per_day)}h`);
  return chips;
}
