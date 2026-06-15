import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { useAuth } from '../auth/AuthContext';
import { suggestModules, resolveDiagnosisModule } from '../utils/diagnosisMapping';
import { getModule, getAllModules } from '../moduleRegistry';
import { showAlert } from '../utils/platform';
import { createManagedPatient, touchPatientRecord } from '../services/patientRecords';
import {
  normalizeHeader, parseDate, parseGender, parseSide, getCell, buildColMap,
  ensureDiagnosis, ensureSharedJob, applyReturnConsiderations, applyDiagnosisAssessment,
} from '../utils/batchImportHelpers';

function clonePatients(existingPatients = []) {
  return JSON.parse(JSON.stringify(existingPatients || []));
}

const IMPORT_FIELD_GROUPS = [
  {
    title: '기본정보',
    description: '환자 기본 정보와 평가 문서 정보',
    fields: ['이름', '등록번호', '생년월일', '재해일자', '키', '체중', '성별', '병원명', '진료과', '담당의', '특이사항', '복귀고려사항'],
  },
  {
    title: '진단',
    description: '진단 코드와 방향, 영상등급 입력',
    fields: [
      '진단코드', '진단명', '방향', 'KLG(우)', 'KLG(좌)', 'Ellman(우)', 'Ellman(좌)',
      '상병상태(우)', '상병상태(좌)', '업무관련성(우)', '업무관련성(좌)',
      '업무관련성낮음사유(우)', '업무관련성낮음사유(좌)', '수직분포원리', '동반척추증',
    ],
  },
  {
    title: '직업',
    description: '모든 모듈이 공유하는 직업 정보',
    fields: ['직종명', '시작일', '종료일', '근무기간(년)', '근무기간(개월)'],
  },
  {
    title: '무릎',
    description: '직업별 무릎 부담 요인',
    fields: ['중량물(kg)', '쪼그려앉기', '계단오르내리기', '무릎비틀기', '출발정지반복', '좁은공간', '무릎접촉충격', '점프착지'],
  },
  {
    title: '어깨',
    description: '직업별 어깨 부담 요인',
    fields: ['오버헤드', '반복중간', '반복빠름', '중량물횟수', '중량물시간', '진동(시간/일)'],
  },
  {
    title: '요추(허리)',
    description: '직업별 작업-자세 조합',
    fields: ['작업명', '자세코드', '작업중량', '횟수/분', '시간값', '시간단위', '보정계수'],
  },
  {
    title: '경추(목)',
    description: '직업별 경추 부담 작업과 노출시간',
    fields: [
      '경추_작업명', '경추_노출유형', '경추_하중(kg)', '경추_교대당운반시간',
      '경추_부자연스러운목자세강제', '경추_비중립정적자세시간',
      '경추_굴곡신전회전측굴동시발생', '경추_고도의정밀작업', '경추_메모',
    ],
  },
  {
    title: '팔꿈치 공통',
    description: '시간적 선후관계와 노출 공통 항목',
    fields: [
      '팔꿈치_시간적선후관계_최근작업변화', '팔꿈치_시간적선후관계_작업변화시점',
      '팔꿈치_시간적선후관계_증상발생까지기간', '팔꿈치_시간적선후관계_휴식시호전',
      '팔꿈치_BK유형', '팔꿈치_BK선택방식', '팔꿈치_문제작업명', '팔꿈치_핵심동작연결성', '팔꿈치_핵심노출유형',
      '팔꿈치_반복동작정도', '팔꿈치_1일노출시간', '팔꿈치_하루작업비중',
      '팔꿈치_주당수행일수', '팔꿈치_작업형태', '팔꿈치_휴식분포',
      '팔꿈치_힘사용', '팔꿈치_비중립자세', '팔꿈치_정적유지', '팔꿈치_직접압박수준', '팔꿈치_진동노출',
    ],
  },
  {
    title: '팔꿈치 BK별',
    description: 'BK2101/2103/2105/2106 유형별 세부 항목',
    fields: [
      '팔꿈치_BK2101_주기초', '팔꿈치_BK2101_시간당반복횟수', '팔꿈치_BK2101_단조반복', '팔꿈치_BK2101_배측굴곡', '팔꿈치_BK2101_회내회외',
      '팔꿈치_BK2105_팔꿈치지지', '팔꿈치_BK2105_반복마찰충격', '팔꿈치_BK2105_압박원인',
      '팔꿈치_BK2106_반복기계적부담', '팔꿈치_BK2106_강제자세', '팔꿈치_BK2106_관절자세유지', '팔꿈치_BK2106_압박원인', '팔꿈치_BK2106_공구압박', '팔꿈치_BK2106_고힘그립',
      '팔꿈치_BK2103_진동공구종류', '팔꿈치_BK2103_진동시간', '팔꿈치_BK2103_손유도공구', '팔꿈치_BK2103_공구압박', '팔꿈치_BK2103_고힘그립',
    ],
  },
  {
    title: '손목 공통',
    description: '시간적 선후관계와 노출 공통 항목',
    fields: [
      '손목_시간적선후관계_최근작업변화', '손목_시간적선후관계_작업변화시점',
      '손목_시간적선후관계_증상발생까지기간', '손목_시간적선후관계_휴식시호전',
      '손목_BK유형', '손목_BK선택방식', '손목_문제작업명', '손목_핵심동작연결성', '손목_공통핵심노출유형',
      '손목_반복동작정도', '손목_1일노출시간', '손목_하루작업비중',
      '손목_주당수행일수', '손목_작업형태', '손목_휴식분포',
      '손목_힘사용', '손목_비중립자세', '손목_정적유지', '손목_직접압박수준', '손목_진동노출',
    ],
  },
  {
    title: '손목 BK별',
    description: 'BK2113/2101/2103/2106 유형별 세부 항목',
    fields: [
      '손목_BK2113_반복손목운동',
      '손목_BK2101_주기초', '손목_BK2101_시간당반복횟수', '손목_BK2101_단조반복', '손목_BK2101_배측굴곡', '손목_BK2101_회내회외',
      '손목_BK2103_진동공구종류', '손목_BK2103_진동시간', '손목_BK2103_공구압박', '손목_BK2103_고강도파지',
      '손목_BK2106_압박원인',
    ],
  },
];

const IMPORT_FIELD_COUNT = IMPORT_FIELD_GROUPS.reduce((sum, group) => sum + group.fields.length, 0);

const BASE_COLUMNS = {
  name: ['이름', 'name'],
  patientNo: ['등록번호', 'patientno', 'registration'],
  birthDate: ['생년월일', 'birth'],
  injuryDate: ['재해일자', 'injury'],
  height: ['키', 'height'],
  weight: ['체중', 'weight'],
  gender: ['성별', 'gender'],
  hospitalName: ['병원명', 'hospital'],
  department: ['진료과', 'department'],
  doctorName: ['담당의', 'doctor'],
  specialNotes: ['특이사항', 'special'],
  returnConsiderations: ['복귀고려사항', 'return'],
  diagCode: ['진단코드', 'code'],
  diagName: ['진단명', 'diag'],
  side: ['방향', 'side'],
  diagConfirmedRight: ['상병상태(우)'],
  diagConfirmedLeft: ['상병상태(좌)'],
  diagAssessmentRight: ['업무관련성(우)'],
  diagAssessmentLeft: ['업무관련성(좌)'],
  diagReasonRight: ['업무관련성낮음사유(우)'],
  diagReasonLeft: ['업무관련성낮음사유(좌)'],
  diagVerticalDistribution: ['수직분포원리'],
  diagConcomitantSpondylosis: ['동반척추증'],
  jobName: ['직종명', 'job'],
  jobStart: ['시작일', 'start'],
  jobEnd: ['종료일', 'end'],
  jobPeriodY: ['근무기간(년)', 'period(년)', 'period_y'],
  jobPeriodM: ['근무기간(개월)', 'period(개월)', 'period_m'],
};

export function BatchImportModal({ onClose, onImport, existingPatients = [] }) {
  const { session } = useAuth();
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [columns, setColumns] = useState([]);
  const [dragover, setDragover] = useState(false);
  const fileRef = useRef();

  const handleFile = (selectedFile) => {
    if (!selectedFile) return;
    setFile(selectedFile);

    const reader = new FileReader();
    reader.onload = event => {
      try {
        const data = new Uint8Array(event.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        if (rows.length > 0) {
          setPreview(rows);
          setColumns(rows[0]);
        }
      } catch (error) {
        showAlert(`파일 읽기 오류: ${error.message}`);
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  };

  const handleImport = async () => {
    if (!preview || preview.length < 2) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }

    const headerRow = preview[0].map(normalizeHeader);
    const moduleConfigs = getAllModules()
      .map(mod => ({ id: mod.id, batchImportConfig: mod.batchImportConfig }))
      .filter(mod => mod.batchImportConfig);

    const colMap = buildColMap(headerRow, [
      BASE_COLUMNS,
      ...moduleConfigs.map(mod => mod.batchImportConfig.columns || {}),
    ]);

    const resultPatients = clonePatients(existingPatients);
    const stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, updatedAssessments: 0, skipped: 0, withDoctorName: 0 };

    for (let rowIndex = 1; rowIndex < preview.length; rowIndex += 1) {
      const row = preview[rowIndex];
      if (!row || row.length === 0) continue;

      const name = String(getCell(row, colMap.name) || '').trim();
      if (!name) continue;

      const birthDate = parseDate(getCell(row, colMap.birthDate));
      const injuryDate = parseDate(getCell(row, colMap.injuryDate));
      const diagCode = String(getCell(row, colMap.diagCode) || '').trim();
      const diagName = String(getCell(row, colMap.diagName) || '').trim();
      const side = parseSide(getCell(row, colMap.side));

      let patient = resultPatients.find(item =>
        item.data.shared?.name === name
        && item.data.shared?.birthDate === birthDate
        && item.data.shared?.injuryDate === injuryDate
      );

      if (!patient) {
        const suggestedModules = suggestModules([{ code: diagCode, name: diagName, side }]);
        const modulesData = {};
        suggestedModules.forEach(moduleId => {
          const mod = getModule(moduleId);
          if (mod?.createModuleData) modulesData[moduleId] = mod.createModuleData();
        });

        patient = createManagedPatient(suggestedModules, modulesData, { session });
        patient.data.shared.name = name;
        patient.data.shared.patientNo = String(getCell(row, colMap.patientNo) || '').trim();
        patient.data.shared.birthDate = birthDate;
        patient.data.shared.injuryDate = injuryDate;
        patient.data.shared.height = String(getCell(row, colMap.height) || '');
        patient.data.shared.weight = String(getCell(row, colMap.weight) || '');
        patient.data.shared.gender = parseGender(getCell(row, colMap.gender));
        patient.data.shared.hospitalName = String(getCell(row, colMap.hospitalName) || '').trim();
        patient.data.shared.department = String(getCell(row, colMap.department) || '').trim();
        patient.data.shared.doctorName = String(getCell(row, colMap.doctorName) || '').trim();
        patient.data.shared.specialNotes = String(getCell(row, colMap.specialNotes) || '').trim();
        patient.data.shared.diagnoses = [];
        patient.data.shared.jobs = [];
        if (patient.data.shared.doctorName) stats.withDoctorName += 1;
        resultPatients.push(patient);
        stats.newPatients += 1;
      }

      const diagnosis = ensureDiagnosis(patient, diagCode, diagName, side, stats);
      if (diagnosis) {
        const diagModuleId = resolveDiagnosisModule(diagnosis, patient.data.activeModules)?.moduleId;
        if (applyDiagnosisAssessment(diagnosis, row, colMap, getCell, diagModuleId)) {
          stats.updatedAssessments += 1;
        }
      }
      const job = ensureSharedJob(patient, row, colMap, getCell, stats);

      moduleConfigs.forEach(mod => {
        mod.batchImportConfig.applyRow({ patient, row, diagnosis, job, colMap, getCell, rowIndex });
      });

      applyReturnConsiderations(
        patient,
        String(getCell(row, colMap.returnConsiderations) || '').trim(),
        moduleConfigs.map(mod => mod.id)
      );
    }

    if (stats.newPatients === 0 && stats.newDiagnoses === 0 && stats.newJobs === 0 && stats.updatedAssessments === 0) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }

    onImport(resultPatients.map(patient => touchPatientRecord(patient, { session })), stats);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal import-modal" onClick={e => e.stopPropagation()}>
        <div className="import-modal-header">
          <div>
            <h2>일괄 Import</h2>
            <p className="import-modal-description">
              엑셀 파일을 읽어 신규 환자를 만들거나 기존 환자 데이터에 병합합니다.
            </p>
          </div>
          <span className="modal-section-badge">지원 형식 .xlsx / .xls / .csv</span>
        </div>

        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">파일 업로드</h3>
              <p className="modal-section-description">첫 행은 컬럼명, 두 번째 행부터 실제 데이터로 해석합니다.</p>
            </div>
            {file && <span className="modal-section-badge">{file.name}</span>}
          </div>

          <div
            className={`import-zone ${dragover ? 'dragover' : ''}`}
            onClick={() => fileRef.current.click()}
            onDragOver={event => { event.preventDefault(); setDragover(true); }}
            onDragLeave={() => setDragover(false)}
            onDrop={event => {
              event.preventDefault();
              setDragover(false);
              handleFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={event => handleFile(event.target.files[0])}
            />
            <p>클릭하거나 파일을 드래그하세요</p>
            <p className="import-zone-note">현재 내보내기 템플릿과 호환되는 헤더를 우선 지원합니다.</p>
            {file && <p className="import-zone-file">선택됨: {file.name}</p>}
          </div>
        </section>

        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">지원 컬럼 그룹</h3>
              <p className="modal-section-description">현재 parser가 인식하는 대표 컬럼들입니다.</p>
            </div>
            <span className="modal-section-badge">{IMPORT_FIELD_COUNT}개</span>
          </div>

          <div className="import-reference-grid">
            {IMPORT_FIELD_GROUPS.map(group => (
              <div key={group.title} className="import-reference-card">
                <div className="import-reference-card-header">
                  <h4>{group.title}</h4>
                  <span className="import-reference-count">{group.fields.length}</span>
                </div>
                <p className="import-reference-description">{group.description}</p>
                <ul className="import-reference-list">
                  {group.fields.map(field => <li key={field}>{field}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </section>

        {preview && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">미리보기</h3>
                <p className="modal-section-description">헤더 {columns.length}개, 데이터 {Math.max(0, preview.length - 1)}행</p>
              </div>
            </div>
            <div className="report-preview">
              <div className="preview-section">
                {columns.join(' | ')}
              </div>
            </div>
          </section>
        )}

        <div className="modal-actions">
          <button className="btn btn-primary" onClick={handleImport} disabled={!preview}>가져오기</button>
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}
