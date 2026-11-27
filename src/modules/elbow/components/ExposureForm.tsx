// 팔꿈치 노출 입력 화면 — 공용 화면(_shared/upperLimb/ExposureForm, P2-73b)에 이 모듈의 값을 묶어 넘기는 얇은 래퍼.
// 라벨·className 접두·빈 상병 이름·힘 수준 낱말은 지금 값 그대로 적는다. prop 이름(elbowDiagnoses)과 테스트의
// vi.mock('../components/ExposureForm') 경로를 그대로 두려고 이 파일을 남긴다.
import { UpperLimbExposureForm } from '../../_shared/upperLimb/ExposureForm';
import type { UpperLimbExposureFormConfig, UpperLimbExposureFormProps } from '../../_shared/upperLimb/ExposureForm';
import {
  BK_TYPE_LABELS,
  BK_TYPE_OPTIONS,
  EXPOSURE_TYPE_OPTIONS,
  resetElbowBranchFields,
} from '../utils/data';
import {
  groupDiagnosesByBkType,
  pickRepresentativeEntry,
} from '../utils/calculations';
import { DiseaseSpecificFields } from './DiseaseSpecificFields';

const ELBOW_EXPOSURE_FORM_CONFIG: UpperLimbExposureFormConfig = {
  classPrefix: 'elbow',
  emptyDiagnosisName: '팔꿈치 상병',
  labels: {
    directLink: '병변 부위와 직접 연결되는 핵심 동작/자세가 있는가',
    taskNamePlaceholder: '해당 직업에서 문제가 되는 작업명을 입력하세요',
    dailyHours: '1일 총시간(시간)',
    shiftShare: '하루 작업 비중(%)',
    daysPerWeek: '주당 수행일수',
    commonExposureTitle: '[질환 공통] 핵심 노출 지표',
    commonExposureCaption: '체크한 항목만 아래에서 세부 정도를 선택합니다',
    branchTitle: '질환별 세부 분기',
    branchCaption: '선택한 BK 유형에 따라 필요한 항목이 달라집니다',
    jobCardSubtitle: '이 직업에서 BK 유형별 노출 특성과 분기 정보를 입력합니다',
    forceMild: '경미',
    awkwardPostureDetail: '비중립 자세 정도',
  },
  bkTypeLabels: BK_TYPE_LABELS,
  bkTypeOptions: BK_TYPE_OPTIONS,
  exposureTypeOptions: EXPOSURE_TYPE_OPTIONS,
  resetBranchFields: resetElbowBranchFields,
  groupDiagnosesByBkType,
  pickRepresentativeEntry,
  DiseaseSpecificFields,
};

export type ExposureFormProps = Omit<UpperLimbExposureFormProps, 'config' | 'diagnoses'> & {
  elbowDiagnoses: UpperLimbExposureFormProps['diagnoses'];
};

export function ExposureForm({
  job,
  jobIndex,
  elbowDiagnoses,
  jobEvaluation,
  errors,
  onChangeEntry,
}: ExposureFormProps) {
  return (
    <UpperLimbExposureForm
      config={ELBOW_EXPOSURE_FORM_CONFIG}
      job={job}
      jobIndex={jobIndex}
      diagnoses={elbowDiagnoses}
      jobEvaluation={jobEvaluation}
      errors={errors}
      onChangeEntry={onChangeEntry}
    />
  );
}
