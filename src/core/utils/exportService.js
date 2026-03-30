import * as XLSX from 'xlsx';
import JSZip from 'jszip';
import { getModule } from '../moduleRegistry';
import { getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { resolveDiagnosisModule } from './diagnosisMapping';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText, getWorkPeriodYearMonth } from './workPeriod';

function generateUnifiedEMR(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const jobs = shared.jobs || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  const hasKnee = activeModules.includes('knee');
  const hasSpine = activeModules.includes('spine');

  // --- b5: 최종 확인 상병명 (상병 코드+이름만) ---
  const b5 = diagnoses
    .filter(d => d.code || d.name)
    .map(d => `${d.code || ''} ${d.name || ''}`.trim())
    .join('\n');

  // --- b6: 직업적 요인 ---
  let b6 = `[직업력]\n`;
  jobs.forEach((j, i) => {
    b6 += `- 직력${i + 1}: ${j.jobName || '-'} | ${getEffectiveWorkPeriodText(j)}\n`;
  });

  if (hasKnee) {
    const kneeMod = getModule('knee');
    const kneeCalc = kneeMod?.computeCalc?.({ shared, module: modules.knee || {} }) || {};
    const { relatedness: rel, cumulativeBurden: cum, jobBurdens: jb } = kneeCalc;

    b6 += `\n<무릎 (슬관절)>\n`;
    (jb || []).filter(j => j.jobName).forEach(j => {
      const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
      b6 += `직종: ${j.jobName || '-'}\n`;
      b6 += `일 중량물 취급량: ${j.weight || '-'}kg\n`;
      b6 += `일 쪼그려 앉기 시간: ${j.squatting || '-'}분\n`;
      if (checked.length > 0) b6 += `보조변수: ${checked.join(', ')}\n`;
      b6 += `무릎 부담 정도: ${j.burden.level}\n\n`;
    });
    b6 += `참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
    b6 += `1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
    b6 += `2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
    b6 += `3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
    b6 += `4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
    if (rel) {
      b6 += `\n[신체부담기여도] ${rel.min}% ~ ${rel.max}%\n`;
      b6 += `[누적신체부담] ${cum}\n`;
    }
  }

  if (hasSpine) {
    const spineMod = getModule('spine');
    const spineCalc = spineMod?.computeCalc?.({ shared, module: modules.spine || {} }) || {};
    const { jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, maxForce } = spineCalc;

    b6 += `\n<척추 (요추) MDDM 평가>\n`;

    // 직업별 결과
    if (jobResults && jobResults.length > 1) {
      jobResults.forEach((jr, i) => {
        b6 += `[직력${i + 1}: ${jr.jobName} (${jr.periodYears.toFixed(1)}년)]\n`;
        b6 += `일일선량: ${jr.dailyDose.dailyDoseKNh.toFixed(2)} kN\xB7h / `;
        b6 += `누적선량: ${jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`}`;
        b6 += ` / 포함 작업 ${jr.tasks.length}개\n`;
      });
      b6 += `\n[합계]\n`;
    }

    b6 += `[평가 결과]\n`;
    b6 += `최대 압박력: ${(maxForce || 0).toLocaleString()} N\n`;
    b6 += `일일선량: ${dailyDose?.dailyDoseKNh?.toFixed(2) || '0.00'} kN\xB7h\n`;
    b6 += `누적선량: ${lifetimeDose?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN\xB7h\n`;
    if (comparison) {
      b6 += `\n[기준 비교]\n`;
      b6 += `DWS2: ${comparison.dws2?.percent?.toFixed(0) || '0'}% (${comparison.dws2?.limit || '-'} MN\xB7h)\n`;
      b6 += `법원기준: ${comparison.court?.percent?.toFixed(0) || '0'}% (${comparison.court?.limit || '-'} MN\xB7h)\n`;
      b6 += `MDDM: ${comparison.mddm?.percent?.toFixed(0) || '0'}% (${comparison.mddm?.limit || '-'} MN\xB7h)\n`;
    }
    if (workRelatedness) {
      b6 += `\n[업무관련성] ${workRelatedness.grade || '-'} (기여도: ${workRelatedness.workContribution || 0}%)\n`;
      b6 += `${workRelatedness.detail || ''}\n`;
    }
  }

  const hasShoulder = activeModules.includes('shoulder');
  if (hasShoulder) {
    const shoulderMod = getModule('shoulder');
    const shoulderCalc = shoulderMod?.computeCalc?.({ shared, module: modules.shoulder || {} }) || {};
    const { totals: shoulderTotals, jobBurdens: sjb, anyRepetitiveExceeded } = shoulderCalc;

    b6 += `\n<어깨 (견관절) BK2117 누적 기준 비교>\n`;
    (shoulderTotals || []).forEach(tot => {
      const ratioStr = tot.totalHours > 0 ? ` / 비율 ${(tot.ratio * 100).toFixed(0)}%${tot.exceeded ? ' [초과]' : ''}` : '';
      b6 += `${tot.label}: ${tot.totalHours > 0 ? tot.totalHours.toFixed(1) + '시간' : '-'} (임계값 ${tot.limit.toLocaleString()}시간${ratioStr})\n`;
    });
    if (anyRepetitiveExceeded) b6 += `※ 반복동작 기준 충족 (중간속도 OR 고도 초과)\n`;
    if ((sjb || []).filter(j => j.jobName).length > 1) {
      b6 += `\n[직력별 기여]\n`;
      (sjb || []).filter(j => j.jobName).forEach((j, i) => {
        b6 += `직력${i + 1}: ${j.jobName} (${j.periodYears > 0 ? j.periodYears.toFixed(1) + '년' : '-'})\n`;
        (j.exposures || []).forEach(exp => {
          if (exp.dailyHours > 0) b6 += `  ${exp.label}: ${exp.dailyHours}시간/일 → 누적 ${exp.cumulativeHours.toFixed(1)}시간\n`;
        });
      });
    }
  }

  // --- b7: 개인적 요인 ---
  const b7 = `- 키: ${shared.height || '-'}cm\n- 몸무게: ${shared.weight || '-'}kg\n- BMI: ${bmi || '-'}\n- 나이: ${age || '-'}세 (재해일 기준)\n- 특이사항: ${shared.specialNotes || '없음'}`;

  // --- b8: 종합소견 ---
  let b8 = '';
  
  if (hasKnee) {
    const kneeMod = getModule('knee');
    const kneeCalcB8 = kneeMod?.computeCalc?.({ shared, module: modules.knee || {} }) || {};
    const { relatedness: relB8, cumulativeBurden: cumB8, jobBurdens: jbB8 } = kneeCalcB8;

    b8 += `\n\n<무릎 (슬관절)>\n\n`;
    (jbB8 || []).filter(j => j.jobName).forEach(j => {
      const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
      b8 += `직종: ${j.jobName || '-'}\n`;
      b8 += `일 중량물 취급량: ${j.weight || '-'}kg\n`;
      b8 += `일 쪼그려 앉기 시간: ${j.squatting || '-'}분\n`;
      if (checked.length > 0) b8 += `보조변수: ${checked.join(', ')}\n`;
      b8 += `무릎 부담 정도: ${j.burden.level}\n\n`;
    });
    b8 += `참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
    b8 += `1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
    b8 += `2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
    b8 += `3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
    b8 += `4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
    if (relB8) {
      b8 += `\n[신체부담기여도] ${relB8.min}% ~ ${relB8.max}%\n\n`;
      b8 += `[누적신체부담] ${cumB8}\n`;
    }
    b8 += `\n**신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은 <근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발 - 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025> 보고서를 참조하기 바람.\n`;
  }

  if (hasShoulder) {
    const shoulderMod = getModule('shoulder');
    const shoulderCalcB8 = shoulderMod?.computeCalc?.({ shared, module: modules.shoulder || {} }) || {};
    const { totals: sTotals, anyRepetitiveExceeded: sRep } = shoulderCalcB8;
    b8 += `\n<어깨 (견관절) BK2117 기준 비교>\n`;
    (sTotals || []).forEach(tot => {
      const ratioStr = tot.totalHours > 0 ? ` / 비율 ${(tot.ratio * 100).toFixed(0)}%${tot.exceeded ? ' [초과]' : ''}` : '';
      b8 += `${tot.label}: ${tot.totalHours > 0 ? tot.totalHours.toFixed(1) + '시간' : '-'} (임계값 ${tot.limit.toLocaleString()}시간${ratioStr})\n`;
    });
    if (sRep) b8 += `※ 반복동작 기준 충족 (중간속도 OR 고도 초과)\n`;
    b8 += `\n`;
  }

  if (hasSpine) {
    const spineMod = getModule('spine');
    const spineCalcB8 = spineMod?.computeCalc?.({ shared, module: modules.spine || {} }) || {};
    const { dailyDose: dd, lifetimeDose: ld, comparison: comp, workRelatedness: wr, maxForce: mf } = spineCalcB8;
    b8 += `\n<척추 (요추) MDDM 평가>\n`;
    b8 += `최대 압박력: ${(mf || 0).toLocaleString()} N\n`;
    b8 += `일일선량: ${dd?.dailyDoseKNh?.toFixed(2) || '0.00'} kN\xB7h\n`;
    b8 += `누적선량: ${ld?.lifetimeDoseMNh?.toFixed(2) || '0.00'} MN\xB7h\n`;
    if (comp) {
      b8 += `[기준 비교] DWS2: ${comp.dws2?.percent?.toFixed(0) || '0'}% / 법원: ${comp.court?.percent?.toFixed(0) || '0'}% / MDDM: ${comp.mddm?.percent?.toFixed(0) || '0'}%\n`;
    }
    if (wr) b8 += `[업무관련성] ${wr.grade || '-'} (기여도: ${wr.workContribution || 0}%)\n`;
    b8 += `\n`;
  }
  b8 +='\n[ 업무관련성 평가 결과 ]\n\n'
  b8 += diagnoses.filter(d => d.code || d.name).map((d, i) => {
    const resolvedModule = resolveDiagnosisModule(d, activeModules);
    let summary = `상병 #${i + 1}: ${d.code} ${d.name}`;

    if (resolvedModule?.moduleId === 'spine') {
      summary += `\n  상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
      if (d.assessmentRight === 'low') summary += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight || [], d.reasonRightOther).split('\n').join('\n    - ')}`;
    } else if (resolvedModule?.moduleId === 'shoulder') {
      if (d.side === 'right' || d.side === 'both') {
        summary += `\n  우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') summary += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight || [], d.reasonRightOther).split('\n').join('\n    - ')}`;
      }
      if (d.side === 'left' || d.side === 'both') {
        summary += `\n  좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') summary += `\n    낮음 사유:\n    - ${getReasonText(d.reasonLeft || [], d.reasonLeftOther).split('\n').join('\n    - ')}`;
      }
    } else if (hasKnee) {
      if (d.side === 'right' || d.side === 'both') {
        summary += `\n  우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') summary += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight || [], d.reasonRightOther).split('\n').join('\n    - ')}`;
      }
      if (d.side === 'left' || d.side === 'both') {
        summary += `\n  좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') summary += `\n    낮음 사유:\n    - ${getReasonText(d.reasonLeft || [], d.reasonLeftOther).split('\n').join('\n    - ')}`;
      }
    }
    return summary;
  }).join('\n\n');

  // --- b9: 복귀 관련 고려사항 ---
  const b9 = modules.knee?.returnConsiderations || modules.shoulder?.returnConsiderations || '';

  return { b5, b6, b7, b8, b9 };
}

function buildUnifiedWorkbook(patient) {
  const shared = patient.data.shared || {};
  const { b5, b6, b7, b8, b9 } = generateUnifiedEMR(patient);
  const wb = XLSX.utils.book_new();
  const wsData = [
    ['업무관련성특별진찰소견서(근골격계질병)', ''],
    ['항목', '내용'],
    ['1.신청상병명', ''],
    ['2.진료기록 및 의학적 소견', ''],
    ['3.최종 확인 상병명', b5],
    ['4.직업적 요인', b6],
    ['5.개인적 요인', b7],
    ['6.종합소견', b8],
    ['7.복귀 관련 고려사항', b9]
  ];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 25 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(wb, ws, '업무관련성특별진찰소견서(근골격계질병)');
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
        usedNames[fileName]++;
        finalName = fileName.replace('.xlsx', `_${usedNames[fileName]}.xlsx`);
      } else {
        usedNames[fileName] = 1;
      }
      const xlsxBuffer = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
      zip.file(finalName, xlsxBuffer);
    } catch (e) {
      console.error(`Export failed: ${patient.data.shared?.name || 'unknown'}`, e);
    }
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = zipName;
  a.click();
  URL.revokeObjectURL(url);
}

export async function exportSelected(patients, selectedIds) {
  const selected = patients.filter(p => selectedIds.has(p.id) && p.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(selected, `업무관련성평가_선택${selected.length}명_${date}.zip`);
}

export async function exportBatch(patients) {
  const valid = patients.filter(p => p.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  await exportAsZip(valid, `업무관련성평가_${valid.length}명_${date}.zip`);
}

// ========== 일괄입력용 서식 Export ==========

const BATCH_HEADERS = [
  '이름', '생년월일', '재해일자', '키', '몸무게', '성별',
  '병원명', '진료과', '담당의', '특이사항', '복귀고려사항',
  '진단코드', '진단명', '방향', 'KLG(우측)', 'KLG(좌측)', 'Ellman(우측)', 'Ellman(좌측)',
  '직종명', '시작일', '종료일', '근무기간(년)', '근무기간(개월)', '중량물(kg)', '쪼그려앉기(분)',
  '계단오르내리기', '무릎비틀림', '출발정지반복', '좁은공간', '무릎접촉충격', '뛰어내리기',
  '오버헤드(시간/일)', '반복중간(시간/일)', '반복빠른(시간/일)', '중량물횟수(회/일)', '중량물시간(초/회)', '진동(시간/일)',
  '작업명', '자세코드', '작업중량(kg)', '횟수/일', '시간값', '시간단위', '보정계수'
];

const GENDER_REVERSE = { male: '남', female: '여' };
const SIDE_REVERSE = { right: '우측', left: '좌측', both: '양측' };

function generateBatchRows(patientList) {
  const rows = [];

  for (const patient of patientList) {
    const shared = patient.data.shared || {};
    const modules = patient.data.modules || {};
    const diagnoses = (shared.diagnoses || []).filter(d => d.code || d.name);
    const jobs = shared.jobs || [];
    const kneeExtras = modules.knee?.jobExtras || [];
    const shoulderExtras = modules.shoulder?.jobExtras || [];
    const spineTasks = modules.spine?.tasks || [];

    // 직업별로 spine task를 그룹핑하여 행 구성
    const firstJobId = jobs[0]?.id || '';
    const jobTaskPairs = []; // [{job, task, kneeExtra}]

    if (jobs.length > 0) {
      for (const job of jobs) {
        const jobSpineTasks = spineTasks.filter(t => (t.sharedJobId || firstJobId) === job.id);
        const extra = kneeExtras.find(e => e.sharedJobId === job.id) || null;
        if (jobSpineTasks.length > 0) {
          jobSpineTasks.forEach(t => jobTaskPairs.push({ job, task: t, extra }));
        } else {
          jobTaskPairs.push({ job, task: null, extra });
        }
      }
      // sharedJobId가 어떤 job에도 안 맞는 task (orphan)
      const allJobIds = new Set(jobs.map(j => j.id));
      spineTasks.filter(t => t.sharedJobId && !allJobIds.has(t.sharedJobId)).forEach(t => {
        jobTaskPairs.push({ job: null, task: t, extra: null });
      });
    } else {
      // job이 없는 경우: task만 나열
      spineTasks.forEach(t => jobTaskPairs.push({ job: null, task: t, extra: null }));
    }

    const rowCount = Math.max(1, diagnoses.length, jobTaskPairs.length);

    for (let i = 0; i < rowCount; i++) {
      const row = [];
      const isFirst = i === 0;

      // merge key — 매 행 반복
      row.push(shared.name || '');
      row.push(shared.birthDate || '');
      row.push(shared.injuryDate || '');

      // shared 필드 — 첫 행에만
      row.push(isFirst ? (shared.height || '') : '');
      row.push(isFirst ? (shared.weight || '') : '');
      row.push(isFirst ? (GENDER_REVERSE[shared.gender] || '') : '');
      row.push(isFirst ? (shared.hospitalName || '') : '');
      row.push(isFirst ? (shared.department || '') : '');
      row.push(isFirst ? (shared.doctorName || '') : '');
      row.push(isFirst ? (shared.specialNotes || '') : '');
      row.push(isFirst ? (modules.knee?.returnConsiderations || modules.shoulder?.returnConsiderations || '') : '');

      // 진단 컬럼
      const diag = diagnoses[i];
      row.push(diag?.code || '');
      row.push(diag?.name || '');
      row.push(diag ? (SIDE_REVERSE[diag.side] || '') : '');
      row.push(diag?.klgRight || '');
      row.push(diag?.klgLeft || '');
      row.push(diag?.ellmanRight || '');
      row.push(diag?.ellmanLeft || '');

      // 직업 + 척추 작업 컬럼 (직업별 그룹핑)
      const pair = jobTaskPairs[i];
      const job = pair?.job;
      const task = pair?.task;
      const extra = pair?.extra;
      const shoulderExtra = job ? shoulderExtras.find(e => e.sharedJobId === job.id) : null;

      row.push(job?.jobName || '');
      row.push(job?.startDate || '');
      row.push(job?.endDate || '');
      if (job) {
        const ym = getWorkPeriodYearMonth(job);
        row.push(ym.years || '');
        row.push(ym.months || '');
      } else {
        row.push('');
        row.push('');
      }

      // 무릎 jobExtras
      row.push(extra?.weight || '');
      row.push(extra?.squatting || '');
      row.push(extra?.stairs ? 'O' : '');
      row.push(extra?.kneeTwist ? 'O' : '');
      row.push(extra?.startStop ? 'O' : '');
      row.push(extra?.tightSpace ? 'O' : '');
      row.push(extra?.kneeContact ? 'O' : '');
      row.push(extra?.jumpDown ? 'O' : '');

      // 어깨 jobExtras (BK2117)
      row.push(shoulderExtra?.overheadHours ?? '');
      row.push(shoulderExtra?.repetitiveMediumHours ?? '');
      row.push(shoulderExtra?.repetitiveFastHours ?? '');
      row.push(shoulderExtra?.heavyLoadCount ?? '');
      row.push(shoulderExtra?.heavyLoadSeconds ?? '');
      row.push(shoulderExtra?.vibrationHours ?? '');

      // 척추 작업 컬럼
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
  const wsData = [BATCH_HEADERS, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = BATCH_HEADERS.map(() => ({ wch: 14 }));
  XLSX.utils.book_append_sheet(wb, ws, '일괄입력용');
  return wb;
}

export function exportBatchFormatSingle(patient) {
  const name = (patient.data.shared?.name || '미입력').replace(/[\\/:*?"<>|]/g, '_');
  const date = new Date().toISOString().split('T')[0];
  const wb = buildBatchWorkbook([patient]);
  XLSX.writeFile(wb, `일괄입력용_${name}_${date}.xlsx`);
}

export function exportBatchFormatSelected(patients, selectedIds) {
  const selected = patients.filter(p => selectedIds.has(p.id) && p.data.shared?.name);
  if (selected.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  const wb = buildBatchWorkbook(selected);
  XLSX.writeFile(wb, `일괄입력용_${selected.length}명_${date}.xlsx`);
}

export function exportBatchFormatAll(patients) {
  const valid = patients.filter(p => p.data.shared?.name);
  if (valid.length === 0) return;
  const date = new Date().toISOString().split('T')[0];
  const wb = buildBatchWorkbook(valid);
  XLSX.writeFile(wb, `일괄입력용_${valid.length}명_${date}.xlsx`);
}
