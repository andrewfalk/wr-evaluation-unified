import { getModule } from '../moduleRegistry';
import { getSideText, getStatusText, getReasonText } from '../../modules/knee/utils/calculations';
import { AUX_LABELS } from '../../modules/knee/utils/data';
import { getDiagnosisModuleHint } from './diagnosisMapping';
import { calculateAge, calculateBMI } from './common';
import { getEffectiveWorkPeriodText } from './workPeriod';

function genKneeBurdenSection(patientData, calc) {
  const { relatedness: r, cumulativeBurden: cum, jobBurdens: jb } = calc;
  let t = `\n  <무릎(슬관절)>\n`;
  jb.forEach((j) => {
    const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
    t += `  직종: ${j.jobName || '-'}\n`;
    t += `  일 중량물 취급량: ${j.weight || '-'}kg\n`;
    t += `  일 쪼그려 앉기 시간: ${j.squatting || '-'}분\n`;
    if (checked.length > 0) t += `  보조변수: ${checked.join(', ')}\n`;
    t += `  무릎 부담 정도: ${j.burden.level}\n`;
  });
  t += `\n  참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
  t += `  1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
  t += `  2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
  t += `  3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
  t += `  4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
  t += `\n  [신체부담기여도] ${r.min}% ~ ${r.max}%\n`;
  t += `  [누적신체부담] ${cum}\n`;
  return t;
}

function genSpineBurdenSection(patientData, calc) {
  const { jobResults, dailyDose, lifetimeDose, comparison, workRelatedness, maxForce } = calc;
  let t = `\n  <척추(요추)>\n`;

  // 직업별 결과 (2개 이상일 때)
  if (jobResults && jobResults.length > 1) {
    t += `  [직력별 평가 결과]\n`;
    jobResults.forEach((jr, i) => {
      t += `  직력${i + 1}: ${jr.jobName} (${jr.periodYears.toFixed(1)}년)\n`;
      t += `  일일선량: ${jr.dailyDose.dailyDoseKNh.toFixed(2)} kN\xB7h / `;
      t += `누적선량: ${jr.lifetimeDose.excluded ? '일일선량 미달' : `${jr.lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h`}\n\n`;
    });
    t += `  [합산 결과]\n`;
  } else {
    t += `  [평가 결과]\n`;
  }

  t += `  최대 압박력: ${maxForce.toLocaleString()} N\n`;
  t += `  일일선량: ${dailyDose.dailyDoseKNh.toFixed(2)} kN\xB7h\n`;
  t += `  누적선량: ${lifetimeDose.lifetimeDoseMNh.toFixed(2)} MN\xB7h\n`;
  t += `\n  [기준 비교]\n`;
  t += `  DWS2: ${comparison.dws2.percent.toFixed(0)}% (${comparison.dws2.limit} MN\xB7h)\n`;
  t += `  법원기준: ${comparison.court.percent.toFixed(0)}% (${comparison.court.limit} MN\xB7h)\n`;
  t += `  MDDM: ${comparison.mddm.percent.toFixed(0)}% (${comparison.mddm.limit} MN\xB7h)\n`;
  t += `\n  [신체부담기여도] ${workRelatedness.grade} (기여도: ${workRelatedness.workContribution}%)\n`;
  t += `  ${workRelatedness.detail}\n`;
  return t;
}

export function generateUnifiedReport(patient) {
  const shared = patient.data.shared || {};
  const modules = patient.data.modules || {};
  const activeModules = patient.data.activeModules || [];
  const diagnoses = shared.diagnoses || [];
  const jobs = shared.jobs || [];

  const age = calculateAge(shared.birthDate, shared.injuryDate);
  const bmi = calculateBMI(shared.height, shared.weight);

  // ---- 헤더 ----
  let t = `업무관련성 특별진찰 소견서\n\n`;
  t += `이름: ${shared.name || '-'}(${shared.gender === 'male' ? '남' : shared.gender === 'female' ? '여' : ''})\n`;
  t += `키/몸무게: ${shared.height || '-'}cm / ${shared.weight || '-'}kg (BMI: ${bmi || '-'})\n`;
  t += `생년월일: ${shared.birthDate || '-'}\n`;
  t += `재해일자: ${shared.injuryDate || '-'} (만 ${age}세)\n\n`;

  // ---- [신청 상병] ----
  t += `[신청 상병]\n`;
  diagnoses.forEach((d, i) => {
    if (d.code || d.name) t += `#${i + 1}. ${d.code} ${d.name} (${getSideText(d.side)})\n`;
  });

  // ---- [특이사항] ----
  t += `\n[특이사항]\n${shared.specialNotes || '-'}\n`;

  // ---- [직업력 및 신체부담 평가] ----
  t += `\n[직업력 및 신체부담 평가]\n`;

  // 1. 직업력
  t += `\n1. 직업력\n`;
  jobs.forEach((j, i) => {
    t += `  직력${i + 1}: ${j.jobName || '-'} | ${getEffectiveWorkPeriodText(j)}\n`;
  });

  // 2. 신체부담평가
  t += `\n2. 신체부담평가\n`;
  for (const moduleId of activeModules) {
    const mod = getModule(moduleId);
    if (!mod?.computeCalc) continue;
    const patientData = { shared, module: modules[moduleId] || {} };
    const calc = mod.computeCalc(patientData);

    if (moduleId === 'knee') {
      t += genKneeBurdenSection(patientData, calc);
    } else if (moduleId === 'spine') {
      t += genSpineBurdenSection(patientData, calc);
    }
  }

  // ---- [종합소견] ----
  t += `\n[종합소견]\n`;
  const hasKnee = activeModules.includes('knee');

  if (hasKnee) {
    const kneeMod = getModule('knee');
    if (kneeMod?.computeCalc) {
      const kneeCalc = kneeMod.computeCalc({ shared, module: modules.knee || {} });
      const { relatedness: r, cumulativeBurden: cum, jobBurdens: jb } = kneeCalc;

      t += `\n\n  <무릎 (슬관절)>\n\n`;
      (jb || []).forEach((j) => {
        const checked = Object.entries(AUX_LABELS).filter(([k]) => j[k]).map(([, v]) => v);
        t += `  직종: ${j.jobName || '-'}\n`;
        t += `  일 중량물 취급량: ${j.weight || '-'}kg\n`;
        t += `  일 쪼그려 앉기 시간: ${j.squatting || '-'}분\n`;
        if (checked.length > 0) t += `  보조변수: ${checked.join(', ')}\n`;
        t += `  무릎 부담 정도: ${j.burden.level}\n\n`;
      });
      t += `  참고) 신체부담 정도는 다음의 4단계로 구분함.\n`;
      t += `  1) 고도: 퇴행성 변화를 유발 또는 가속하는 것이 확실함(definite)\n`;
      t += `  2) 중등도상: 퇴행성 변화를 유발 또는 가속하기에 충분함(probable)\n`;
      t += `  3) 중등도하: 퇴행성 변화를 유발 또는 가속할 가능성이 있음(possible)\n`;
      t += `  4) 경도: 퇴행성 변화를 유발 또는 가속하기 어려움(no related)\n`;
      t += `\n  [신체부담기여도] ${r.min}% ~ ${r.max}%\n\n`;
      t += `  [누적신체부담] ${cum}\n`;
      t += `\n  **신체부담정도, 신체부담 기여도, 누적 신체부담에 관한 자세한 사항은\n`;
      t += `  <근골격계 질환의 업무관련성 특별진찰 표준화를 위한 모델 개발\n`;
      t += `  - 무릎 관절염을 대상으로 -, 대한직업환경의학회, 2025>\n`;
      t += `  보고서를 참조하기 바람.\n`;
      t += `\n  [ 업무관련성 평가 결과 ]\n`;
    }
  }

  diagnoses.forEach((d, i) => {
    if (!(d.code || d.name)) return;
    const hint = getDiagnosisModuleHint(d);
    t += `\n상병 #${i + 1}: ${d.code} ${d.name}\n`;

    if (hint?.moduleId === 'spine') {
      // 척추: 좌우 없이 단일 (confirmedRight/assessmentRight 필드 재활용)
      t += `  상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
      if (d.assessmentRight === 'low') t += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
      t += `\n`;
    } else if (hasKnee) {
      // 무릎: 좌/우별 출력
      if (d.side === 'right' || d.side === 'both') {
        t += `  우측: 상병 상태(${getStatusText(d.confirmedRight)}) / 업무관련성(${d.assessmentRight === 'high' ? '높음' : d.assessmentRight === 'low' ? '낮음' : '-'})`;
        if (d.assessmentRight === 'low') t += `\n    낮음 사유:\n    - ${getReasonText(d.reasonRight, d.reasonRightOther).split('\n').join('\n    - ')}`;
        t += `\n`;
      }
      if (d.side === 'left' || d.side === 'both') {
        t += `  좌측: 상병 상태(${getStatusText(d.confirmedLeft)}) / 업무관련성(${d.assessmentLeft === 'high' ? '높음' : d.assessmentLeft === 'low' ? '낮음' : '-'})`;
        if (d.assessmentLeft === 'low') t += `\n    낮음 사유:\n    - ${getReasonText(d.reasonLeft, d.reasonLeftOther).split('\n').join('\n    - ')}`;
        t += `\n`;
      }
    }
  });

  // ---- [복귀 관련 고려사항] ----
  const kneeData = modules.knee || {};
  if (kneeData.returnConsiderations) {
    t += `\n[복귀 관련 고려사항]\n${kneeData.returnConsiderations}\n`;
  }

  // ---- 꼬리 ----
  t += `\n${'─'.repeat(50)}\n${shared.evaluationDate || '-'}\n${shared.hospitalName || '-'} ${shared.department || ''}\n담당의: ${shared.doctorName || '-'}`;

  return t;
}
