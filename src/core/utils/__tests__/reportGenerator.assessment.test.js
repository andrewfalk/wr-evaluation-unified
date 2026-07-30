import { describe, expect, it } from 'vitest';
import { generateUnifiedReport } from '../reportGenerator.js';

function makePatient({ diagnoses = [], activeModules = [], reportOptions } = {}) {
  return {
    id: 'p1',
    data: {
      shared: {
        name: '', gender: '', height: '', weight: '', birthDate: '', injuryDate: '',
        specialNotes: '', jobs: [], diagnoses,
        hospitalName: '', department: '', doctorName: '', evaluationDate: '',
        ...(reportOptions ? { reportOptions } : {}),
      },
      modules: {},
      activeModules,
    },
  };
}

function kneeDiag(overrides = {}) {
  return {
    id: 'd1', code: 'M17.0', name: '무릎 관절증', side: 'right',
    confirmedRight: 'confirmed', assessmentRight: 'high',
    reasonRight: [], reasonRightOther: '',
    confirmedLeft: '', assessmentLeft: '', reasonLeft: [], reasonLeftOther: '',
    ...overrides,
  };
}

describe('generateUnifiedReport — [업무관련성 평가 결과] 배선(assessmentGroups.js 연동)', () => {
  it('그룹 옵션 꺼짐(기본값): 상병별 개별 문구를 그대로 출력한다', () => {
    const patient = makePatient({ diagnoses: [kneeDiag()], activeModules: ['knee'] });
    const text = generateUnifiedReport(patient);
    expect(text).toContain('[업무관련성 평가 결과]');
    expect(text).toContain('#1: M17.0 무릎 관절증');
    expect(text).toContain('  우측: 상병 상태(확인) / 업무관련성(높음)');
  });

  it('낮음 사유가 있으면 2칸 들여쓰기 불릿으로 나온다', () => {
    const patient = makePatient({
      diagnoses: [kneeDiag({ assessmentRight: 'low', reasonRight: ['lowBurden'] })],
      activeModules: ['knee'],
    });
    const text = generateUnifiedReport(patient);
    expect(text).toContain('  낮음 사유:\n  - 누적 신체부담 낮음');
  });

  it('그룹 옵션 켜짐: 패턴 그룹 형식으로 출력하고 개별 헤더는 나오지 않는다', () => {
    const patient = makePatient({
      diagnoses: [
        kneeDiag({ id: 'd1' }),
        kneeDiag({ id: 'd2', side: 'left', confirmedLeft: 'confirmed', assessmentLeft: 'high' }),
      ],
      activeModules: ['knee'],
      reportOptions: { groupAssessmentResults: true },
    });
    const text = generateUnifiedReport(patient);
    expect(text).toContain('[상병 확인 · 업무관련성 높음] 2개');
    expect(text).toContain('#1. M17.0 무릎 관절증 (우측)\n#2. M17.0 무릎 관절증 (좌측)');
    expect(text).not.toContain('#1: M17.0');
  });

  it('미완료 평가단위는 그룹 형식에서 [미입력/검토 필요]로 나온다', () => {
    const patient = makePatient({
      diagnoses: [kneeDiag({ confirmedRight: '', assessmentRight: '' })],
      activeModules: ['knee'],
      reportOptions: { groupAssessmentResults: true },
    });
    const text = generateUnifiedReport(patient);
    expect(text).toContain('[미입력/검토 필요] 1개\n#1. M17.0 무릎 관절증 (우측)');
  });

  it('방향 미선택 상병은 그룹 형식에서도 문서에서 사라지지 않고 [미입력/검토 필요]에 남는다', () => {
    const patient = makePatient({
      diagnoses: [kneeDiag({ side: '' })],
      activeModules: ['knee'],
      reportOptions: { groupAssessmentResults: true },
    });
    const text = generateUnifiedReport(patient);
    expect(text).toContain('[미입력/검토 필요] 1개\n#1. M17.0 무릎 관절증 (방향 미선택)');
  });
});
