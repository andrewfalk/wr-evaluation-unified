import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { getBk2101RepetitionPerHour } from '../../modules/elbow/utils/calculations';
import { resolveMddmStatus } from '../../modules/spine/utils/calculations';
import { EXPOSURE_TYPE_LABELS as CERVICAL_EXPOSURE_TYPE_LABELS } from '../../modules/cervical/utils/data';
import { getWorkPeriodYearMonth } from './workPeriod';
import { generateUnifiedEMR } from './emrReport';

export { generateEMRFieldData, generateConsultReplyFieldData } from './emrReport';

function formatCervicalExposureTypes(exposureTypes = []) {
  return (exposureTypes || [])
    .map(type => CERVICAL_EXPOSURE_TYPE_LABELS[type] || type)
    .join('|');
}

function buildUnifiedWorkbook(patient) {
  const shared = patient.data.shared || {};
  const { b5, b6, b7, b8, b9, consultReplySummary } = generateUnifiedEMR(patient);
  const b8Full = consultReplySummary ? b8 + '\n\n' + consultReplySummary : b8;
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성특별진찰소견서(근골격계질병)', ''],
    ['항목', '내용'],
    ['1.신청상병명', ''],
    ['2.진료기록 및 의학적 소견', ''],
    ['3.최종 확인 상병명', b5],
    ['4.직업적 요인', b6],
    ['5.개인적 요인', b7],
    ['6.종합소견', b8Full],
    ['7.복귀 관련 고려사항', b9]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성평가');
  const name = (shared.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = (shared.injuryDate || new Date().toISOString().split('T')[0]).replace(/[\\/:*?"<>|]/g, '-');
  return { wb, fileName: `업무관련성평가_${name}_${date}.xlsx` };
}

export function exportSingle(patient) {
  const { wb, fileName } = buildUnifiedWorkbook(patient);
  XLSX.writeFile(wb, fileName);
}

async function exportAsZip(patientList, zipName) {
  const zip = new JSZip();
  const usedNames = {};

  for (const patient of patientList) {
    try {
      const { wb, fileName } = buildUnifiedWorkbook(patient);
      let finalName = fileName;
      if (usedNames[fileName]) {
        usedNames[fileName] += 1;
        finalName = fileName.replace('.xlsx', `_${usedNames[fileName]}.xlsx`);
      } else {
        usedNames[fileName] = 1;
      }

      const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      zip.file(finalName, xlsxBuffer);
    } catch (error) {
      console.error(`Export failed: ${patient.data.shared?.name || 'unknown'}`, error);
    }
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = zipName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function exportSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(selected, `업무관련성평가_선택${selected.length}명_${date}.zip`);
}

export async function exportBatch(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(valid, `업무관련성평가_${valid.length}명_${date}.zip`);
}

export const BATCH_HEADERS = [
  '등록번호', '이름', '성별', '생년월일', '재해일자', '키', '체중',
  '병원명', '진료과', '담당의', '특이사항', '복귀고려사항',
  '진단코드', '진단명', '방향', 'KLG(우)', 'KLG(좌)', 'Ellman(우)', 'Ellman(좌)',
  '상병상태(우)', '상병상태(좌)', '업무관련성(우)', '업무관련성(좌)',
  '업무관련성낮음사유(우)', '업무관련성낮음사유(좌)', '수직분포원리', '동반척추증',
  '직종명', '시작일', '종료일', '근무기간(년)', '근무기간(개월)',
  '중량물(kg)', '쪼그려앉기(분)', '계단오르내리기', '무릎비틀기', '출발정지반복', '좁은공간', '무릎접촉충격', '점프착지',
  '오버헤드(시간/일)', '반복중간(시간/일)', '반복빠름(시간/일)', '중량물횟수(회/일)', '중량물시간(초/회)', '진동(시간/일)',
  '경추_작업명', '경추_노출유형', '경추_하중(kg)', '경추_교대당운반시간', '경추_부자연스러운목자세강제',
  '경추_비중립정적자세시간', '경추_굴곡신전회전측굴동시발생', '경추_고도의정밀작업', '경추_메모',
  '팔꿈치_시간적선후관계_최근작업변화', '팔꿈치_시간적선후관계_작업변화시점', '팔꿈치_시간적선후관계_증상발생까지기간', '팔꿈치_시간적선후관계_휴식시호전',
  '팔꿈치_BK유형', '팔꿈치_BK선택방식', '팔꿈치_문제작업명', '팔꿈치_핵심동작연결성', '팔꿈치_공통핵심노출유형', '팔꿈치_반복동작정도',
  '팔꿈치_1일노출시간', '팔꿈치_하루작업비중', '팔꿈치_주당수행일수', '팔꿈치_작업형태', '팔꿈치_휴식분포',
  '팔꿈치_힘사용', '팔꿈치_비중립자세', '팔꿈치_정적유지', '팔꿈치_직접압박수준', '팔꿈치_진동노출',
  '팔꿈치_BK2101_주기초', '팔꿈치_BK2101_시간당반복횟수', '팔꿈치_BK2101_단조반복', '팔꿈치_BK2101_배측굴곡', '팔꿈치_BK2101_회내회외',
  '팔꿈치_BK2103_진동공구종류', '팔꿈치_BK2103_진동시간', '팔꿈치_BK2103_공구를강하게쥐거나누르면서사용하는작업',
  '팔꿈치_BK2105_팔꿈치지지', '팔꿈치_BK2105_압박원인',
  '팔꿈치_BK2106_압박원인',
  '손목_시간적선후관계_최근작업변화', '손목_시간적선후관계_작업변화시점', '손목_시간적선후관계_증상발생까지기간', '손목_시간적선후관계_휴식시호전',
  '손목_BK유형', '손목_BK선택방식', '손목_문제작업명', '손목_핵심동작연결성', '손목_공통핵심노출유형', '손목_반복동작정도',
  '손목_1일노출시간', '손목_하루작업비중', '손목_주당수행일수', '손목_작업형태', '손목_휴식분포',
  '손목_힘사용', '손목_비중립자세', '손목_정적유지', '손목_직접압박수준', '손목_진동노출',
  '손목_BK2113_반복손목운동',
  '손목_BK2101_주기초', '손목_BK2101_시간당반복횟수', '손목_BK2101_단조반복', '손목_BK2101_배측굴곡', '손목_BK2101_회내회외',
  '손목_BK2103_진동공구종류', '손목_BK2103_진동시간', '손목_BK2103_공구압박', '손목_BK2103_고강도파지',
  '손목_BK2106_압박원인',
  '작업명', '자세코드', '작업중량(kg)', '횟수/분', '시간값', '시간단위', '보정계수',
];

const GENDER_REVERSE = { male: '남', female: '여' };
const SIDE_REVERSE = { right: '우측', left: '좌측', both: '양측' };

function getAssessmentLevelText(level) {
  return level === 'high' ? '높음' : level === 'low' ? '낮음' : '';
}

export function generateBatchRows(patientList) {
  const rows = [];

  for (const patient of patientList) {
    const shared = patient.data.shared || {};
    const modules = patient.data.modules || {};
    const diagnoses = (shared.diagnoses || []).filter(diag => diag.code || diag.name);
    const jobs = shared.jobs || [];
    const kneeExtras = modules.knee?.jobExtras || [];
    const shoulderExtras = modules.shoulder?.jobExtras || [];
    const cervicalTasks = modules.cervical?.tasks || [];
    // MDDM이 '평가함'(present)일 때만 작업 행을 만든다. unknown(WBV-only)·none(해당없음)은 빈 배열.
    const spineModule = modules.spine || {};
    const spineTasks = resolveMddmStatus(spineModule) === 'present' ? (spineModule.tasks || []) : [];
    const elbowTemporal = modules.elbow?.temporalSequence || modules.elbow?.temporalRelation || {};
    const elbowJobEvaluations = modules.elbow?.jobEvaluations || [];
    const wristTemporal = modules.wrist?.temporalSequence || modules.wrist?.temporalRelation || {};
    const wristJobEvaluations = modules.wrist?.jobEvaluations || [];

    const firstJobId = jobs[0]?.id || '';
    const jobTaskPairs = [];
    const elbowPairs = [];
    const wristPairs = [];

    if (jobs.length > 0) {
      for (const job of jobs) {
        const jobSpineTasks = spineTasks.filter(task => (task.sharedJobId || firstJobId) === job.id);
        const jobCervicalTasks = cervicalTasks.filter(task => (task.sharedJobId || firstJobId) === job.id);
        const kneeExtra = kneeExtras.find(extra => extra.sharedJobId === job.id) || null;
        const elbowJobEvaluation = elbowJobEvaluations.find(item => item.sharedJobId === job.id);
        const wristJobEvaluation = wristJobEvaluations.find(item => item.sharedJobId === job.id);

        (elbowJobEvaluation?.diagnosisEntries || []).forEach(entry => {
          const diagnosis = diagnoses.find(item => item.id === entry.diagnosisId);
          if (diagnosis) {
            elbowPairs.push({ job, diagnosis, entry });
          }
        });

        (wristJobEvaluation?.diagnosisEntries || []).forEach(entry => {
          const diagnosis = diagnoses.find(item => item.id === entry.diagnosisId);
          if (diagnosis) {
            wristPairs.push({ job, diagnosis, entry });
          }
        });

        const pairCount = Math.max(jobSpineTasks.length, jobCervicalTasks.length, 1);
        for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
          jobTaskPairs.push({
            job,
            task: jobSpineTasks[pairIndex] || null,
            cervicalTask: jobCervicalTasks[pairIndex] || null,
            kneeExtra,
          });
        }
      }
    } else {
      const pairCount = Math.max(spineTasks.length, cervicalTasks.length, 1);
      for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        jobTaskPairs.push({
          job: null,
          task: spineTasks[pairIndex] || null,
          cervicalTask: cervicalTasks[pairIndex] || null,
          kneeExtra: null,
        });
      }
    }

    const rowCount = Math.max(1, diagnoses.length, jobTaskPairs.length, elbowPairs.length, wristPairs.length);

    for (let index = 0; index < rowCount; index += 1) {
      const row = [];
      const isFirst = index === 0;
      const elbowPair = elbowPairs[index] || null;
      const wristPair = wristPairs[index] || null;
      const pair = jobTaskPairs[index];
      const diag = elbowPair?.diagnosis || wristPair?.diagnosis || diagnoses[index];
      const job = elbowPair?.job || wristPair?.job || pair?.job;
      const task = pair?.task;
      const cervicalTask = pair?.cervicalTask;
      const kneeExtra = job ? (pair?.kneeExtra || kneeExtras.find(extra => extra.sharedJobId === job.id) || null) : pair?.kneeExtra;
      const shoulderExtra = job ? shoulderExtras.find(extra => extra.sharedJobId === job.id) : null;
      const elbowEntry = elbowPair?.entry || null;
      const wristEntry = wristPair?.entry || null;

      row.push(shared.patientNo || '');                              // A 등록번호
      row.push(shared.name || '');                                   // B 이름
      row.push(isFirst ? (GENDER_REVERSE[shared.gender] || '') : ''); // C 성별
      row.push(shared.birthDate || '');                              // D 생년월일
      row.push(shared.injuryDate || '');                             // E 재해일자
      row.push(isFirst ? (shared.height || '') : '');                // F 키
      row.push(isFirst ? (shared.weight || '') : '');                // G 체중
      row.push(isFirst ? (shared.hospitalName || '') : '');
      row.push(isFirst ? (shared.department || '') : '');
      row.push(isFirst ? (shared.doctorName || '') : '');
      row.push(isFirst ? (shared.specialNotes || '') : '');
      row.push(isFirst ? (modules.knee?.returnConsiderations || modules.wrist?.returnConsiderations || modules.shoulder?.returnConsiderations || modules.elbow?.returnConsiderations || modules.cervical?.returnConsiderations || '') : '');

      row.push(diag?.code || '');
      row.push(diag?.name || '');
      row.push(diag ? (SIDE_REVERSE[diag.side] || '') : '');
      row.push(diag?.klgRight || '');
      row.push(diag?.klgLeft || '');
      row.push(diag?.ellmanRight || '');
      row.push(diag?.ellmanLeft || '');

      row.push(diag?.confirmedRight ? getStatusText(diag.confirmedRight) : '');
      row.push(diag?.confirmedLeft ? getStatusText(diag.confirmedLeft) : '');
      row.push(getAssessmentLevelText(diag?.assessmentRight));
      row.push(getAssessmentLevelText(diag?.assessmentLeft));
      row.push(diag?.assessmentRight === 'low' ? getReasonText(diag.reasonRight || [], diag.reasonRightOther) : '');
      row.push(diag?.assessmentLeft === 'low' ? getReasonText(diag.reasonLeft || [], diag.reasonLeftOther) : '');
      row.push(diag?.verticalDistribution ? getStatusText(diag.verticalDistribution) : '');
      row.push(diag?.concomitantSpondylosis ? getStatusText(diag.concomitantSpondylosis) : '');

      row.push(job?.jobName || '');
      row.push(job?.startDate || '');
      row.push(job?.endDate || '');
      if (job) {
        const yearMonth = getWorkPeriodYearMonth(job);
        row.push(yearMonth.years || '');
        row.push(yearMonth.months || '');
      } else {
        row.push('');
        row.push('');
      }

      row.push(kneeExtra?.weight || '');
      row.push(kneeExtra?.squatting || '');
      row.push(kneeExtra?.stairs ? 'O' : '');
      row.push(kneeExtra?.kneeTwist ? 'O' : '');
      row.push(kneeExtra?.startStop ? 'O' : '');
      row.push(kneeExtra?.tightSpace ? 'O' : '');
      row.push(kneeExtra?.kneeContact ? 'O' : '');
      row.push(kneeExtra?.jumpDown ? 'O' : '');

      row.push(shoulderExtra?.overheadHours ?? '');
      row.push(shoulderExtra?.repetitiveMediumHours ?? '');
      row.push(shoulderExtra?.repetitiveFastHours ?? '');
      row.push(shoulderExtra?.heavyLoadCount ?? '');
      row.push(shoulderExtra?.heavyLoadSeconds ?? '');
      row.push(shoulderExtra?.vibrationHours ?? '');

      row.push(cervicalTask?.name || '');
      row.push(formatCervicalExposureTypes(cervicalTask?.exposure_types || []));
      row.push(cervicalTask?.load_weight_kg || '');
      row.push(cervicalTask?.carry_hours_per_shift || '');
      row.push(cervicalTask?.forced_neck_posture === 'yes' ? '예' : cervicalTask?.forced_neck_posture === 'no' ? '아니오' : '');
      row.push(cervicalTask?.neck_nonneutral_hours_per_day || '');
      row.push(cervicalTask?.combined_flexion_rotation_posture === 'yes' ? '예' : cervicalTask?.combined_flexion_rotation_posture === 'no' ? '아니오' : '');
      row.push(cervicalTask?.precision_work === 'yes' ? '예' : cervicalTask?.precision_work === 'no' ? '아니오' : '');
      row.push(cervicalTask?.notes || '');

      row.push(isFirst ? (elbowTemporal.recent_task_change || '') : '');
      row.push(isFirst ? (elbowTemporal.task_change_date || '') : '');
      row.push(isFirst ? (elbowTemporal.symptom_onset_interval || '') : '');
      row.push(isFirst ? (elbowTemporal.improves_with_rest || '') : '');
      row.push(elbowEntry?.selectedBkType || '');
      row.push(elbowEntry?.bkSelectionMode || '');
      row.push(elbowEntry?.main_task_name || '');
      row.push(elbowEntry?.direct_anatomic_link || '');
      row.push((elbowEntry?.exposure_types || []).join('|'));
      row.push(elbowEntry?.repetition_level || '');
      row.push(elbowEntry?.daily_exposure_hours || '');
      row.push(elbowEntry?.shift_share_percent || '');
      row.push(elbowEntry?.days_per_week || '');
      row.push(elbowEntry?.work_pattern || '');
      row.push(elbowEntry?.rest_distribution || '');
      row.push(elbowEntry?.force_level || '');
      row.push(elbowEntry?.awkward_posture_level || '');
      row.push(elbowEntry?.static_holding_level || '');
      row.push(elbowEntry?.direct_pressure_level || '');
      row.push(elbowEntry?.vibration_exposure || '');

      row.push(elbowEntry?.bk2101_cycle_seconds || '');
      row.push(elbowEntry ? getBk2101RepetitionPerHour(elbowEntry) || '' : '');
      row.push(elbowEntry?.bk2101_monotony || '');
      row.push(elbowEntry?.bk2101_forced_dorsal_extension || '');
      row.push(elbowEntry?.bk2101_prosupination || '');

      row.push((elbowEntry?.bk2103_vibration_tool_type || []).join('|'));
      row.push(elbowEntry?.bk2103_daily_vibration_hours || '');
      row.push(elbowEntry?.bk2103_tool_pressing || '');

      row.push(elbowEntry?.bk2105_elbow_leaning || '');
      row.push((elbowEntry?.bk2105_pressure_source || []).join('|'));
      row.push((elbowEntry?.bk2106_pressure_source || []).join('|'));

      row.push(isFirst ? (wristTemporal.recent_task_change || '') : '');
      row.push(isFirst ? (wristTemporal.task_change_date || '') : '');
      row.push(isFirst ? (wristTemporal.symptom_onset_interval || '') : '');
      row.push(isFirst ? (wristTemporal.improves_with_rest || '') : '');
      row.push(wristEntry?.selectedBkType || '');
      row.push(wristEntry?.bkSelectionMode || '');
      row.push(wristEntry?.main_task_name || '');
      row.push(wristEntry?.direct_anatomic_link || '');
      row.push((wristEntry?.exposure_types || []).join('|'));
      row.push(wristEntry?.repetition_level || '');
      row.push(wristEntry?.daily_exposure_hours || '');
      row.push(wristEntry?.shift_share_percent || '');
      row.push(wristEntry?.days_per_week || '');
      row.push(wristEntry?.work_pattern || '');
      row.push(wristEntry?.rest_distribution || '');
      row.push(wristEntry?.force_level || '');
      row.push(wristEntry?.awkward_posture_level || '');
      row.push(wristEntry?.static_holding_level || '');
      row.push(wristEntry?.direct_pressure_level || '');
      row.push(wristEntry?.vibration_exposure || '');
      row.push(wristEntry?.bk2113_repetitive_wrist_motion || '');
      row.push(wristEntry?.bk2101_cycle_seconds || '');
      row.push(wristEntry ? getBk2101RepetitionPerHour(wristEntry) || '' : '');
      row.push(wristEntry?.bk2101_monotony || '');
      row.push(wristEntry?.bk2101_forced_dorsal_extension || '');
      row.push(wristEntry?.bk2101_prosupination || '');
      row.push((wristEntry?.bk2103_vibration_tool_type || []).join('|'));
      row.push(wristEntry?.bk2103_daily_vibration_hours || '');
      row.push(wristEntry?.bk2103_tool_pressing || '');
      row.push(wristEntry?.bk2103_frequent_high_force_grip || '');
      row.push((wristEntry?.bk2106_pressure_source || []).join('|'));

      row.push(task?.name || '');
      row.push(task?.posture || '');
      row.push(task?.weight ?? '');
      row.push(task?.frequency ?? '');
      row.push(task?.timeValue ?? '');
      row.push(task?.timeUnit || '');
      row.push(task?.correctionFactor ?? '');

      rows.push(row);
    }
  }

  return rows;
}

function buildBatchWorkbook(patientList) {
  const dataRows = generateBatchRows(patientList);
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([BATCH_HEADERS, ...dataRows]);
  ws['!cols'] = BATCH_HEADERS.map(() => ({ wch: 18 }));
  XLSX.utils.book_append_sheet(wb, ws, '일괄입력');
  return wb;
}

export function exportBatchFormatSingle(patient) {
  const name = (patient.data.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook([patient]), `일괄입력_${name}_${date}.xlsx`);
}

export function exportBatchFormatSelected(patients, selectedIds) {
  const selected = patients.filter(patient => selectedIds.has(patient.id) && patient.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(selected), `일괄입력_${selected.length}명_${date}.xlsx`);
}

export function exportBatchFormatAll(patients) {
  const valid = patients.filter(patient => patient.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook(valid), `일괄입력_${valid.length}명_${date}.xlsx`);
}

// 헤더만 있는 빈 일괄입력 양식 — 환자가 없어도 처음 사용자가 받아 작성할 수 있도록 항상 제공.
export function exportBatchTemplate() {
  const date = new Date().toISOString().split('T')[0];
  XLSX.writeFile(buildBatchWorkbook([]), `일괄입력_양식_${date}.xlsx`);
}
