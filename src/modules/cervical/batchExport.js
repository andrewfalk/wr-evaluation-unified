// 일괄 내보내기(엑셀 일괄 입력 형식) 경추 구간 — Phase 2 C6 P2-55b. 옛 core 열 표의 cervical 9열 그대로.
// ctx = BatchRowContext(src/core/export/batchColumns.ts) — cervicalTask는 core의 행 짝짓기가 고른 경추 작업.
import { EXPOSURE_TYPE_LABELS } from './utils/data';

function formatExposureTypes(exposureTypes = []) {
  return (exposureTypes || [])
    .map(type => EXPOSURE_TYPE_LABELS[type] || type)
    .join('|');
}

function yesNoText(value) {
  return value === 'yes' ? '예' : value === 'no' ? '아니오' : '';
}

export const cervicalBatchExport = {
  order: 30,
  columns: [
    { header: '경추_작업명', cell: ({ cervicalTask }) => cervicalTask?.name || '' },
    { header: '경추_노출유형', cell: ({ cervicalTask }) => formatExposureTypes(cervicalTask?.exposure_types || []) },
    { header: '경추_하중(kg)', cell: ({ cervicalTask }) => cervicalTask?.load_weight_kg || '' },
    { header: '경추_교대당운반시간', cell: ({ cervicalTask }) => cervicalTask?.carry_hours_per_shift || '' },
    { header: '경추_부자연스러운목자세강제', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.forced_neck_posture) },
    { header: '경추_비중립정적자세시간', cell: ({ cervicalTask }) => cervicalTask?.neck_nonneutral_hours_per_day || '' },
    { header: '경추_굴곡신전회전측굴동시발생', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.combined_flexion_rotation_posture) },
    { header: '경추_고도의정밀작업', cell: ({ cervicalTask }) => yesNoText(cervicalTask?.precision_work) },
    { header: '경추_메모', cell: ({ cervicalTask }) => cervicalTask?.notes || '' },
  ],
};
