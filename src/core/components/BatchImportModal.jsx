import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { createPatient, createDiagnosis, createSharedJob } from '../utils/data';
import { suggestModules } from '../utils/diagnosisMapping';
import { getModule } from '../moduleRegistry';
import { createKneeJobExtras } from '../../modules/knee/utils/data';
import { formatWorkPeriod } from '../utils/workPeriod';
import { showAlert } from '../utils/platform';

export function BatchImportModal({ onClose, onImport, existingPatients = [] }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [columns, setColumns] = useState([]);
  const [dragover, setDragover] = useState(false);
  const fileRef = useRef();

  const handleFile = (f) => {
    if (!f) return;
    setFile(f);

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const json = XLSX.utils.sheet_to_json(sheet, { header: 1 });

        if (json.length > 0) {
          setColumns(json[0]);
          setPreview(json);
        }
      } catch (err) {
        showAlert('파일 읽기 오류: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(f);
  };

  const handleImport = async () => {
    if (!preview || preview.length < 2) {
      await showAlert('데이터가 없습니다');
      return;
    }

    const headers = preview[0].map(h => (h || '').toString().toLowerCase());
    const findCol = (keywords) => headers.findIndex(h => keywords.some(k => h.includes(k)));

    const colMap = {
      name: findCol(['이름', 'name']),
      birthDate: findCol(['생년월일', 'birth']),
      injuryDate: findCol(['재해', 'injury']),
      height: findCol(['키', 'height']),
      weight: findCol(['몸무게', 'weight']),
      gender: findCol(['성별', 'gender', 'sex']),
      hospitalName: findCol(['병원', 'hospital']),
      department: findCol(['진료과', 'department', 'dept']),
      doctorName: findCol(['담당의', 'doctor', '의사']),
      specialNotes: findCol(['특이사항', 'special', 'note']),
      returnConsiderations: findCol(['복귀', 'return', 'consideration']),
      diagCode: findCol(['진단코드', 'code']),
      diagName: findCol(['진단명', 'diag']),
      side: findCol(['부위', 'side']),
      jobName: findCol(['직종', 'job']),
      jobStart: findCol(['시작', 'start']),
      jobEnd: findCol(['종료', 'end']),
      jobPeriodY: findCol(['근무기간(년)', '기간(년)', 'period_y']),
      jobPeriodM: findCol(['근무기간(개월)', '기간(개월)', 'period_m']),
      jobWeight: findCol(['중량', 'kg']),
      jobSquat: findCol(['쪼그', 'squat']),
      klgRight: findCol(['klg(우측)', 'klg우측', 'klg_right', 'klg(right)']),
      klgLeft: findCol(['klg(좌측)', 'klg좌측', 'klg_left', 'klg(left)']),
      stairs: findCol(['계단', 'stair']),
      kneeTwist: findCol(['비틀', 'twist']),
      startStop: findCol(['출발', 'start_stop', '정지']),
      tightSpace: findCol(['좁은', 'tight', 'space']),
      kneeContact: findCol(['접촉', 'contact', '충격']),
      jumpDown: findCol(['뛰어', 'jump'])
    };

    const sideMap = {
      '우측': 'right', '좌측': 'left', '양측': 'both',
      'right': 'right', 'left': 'left', 'both': 'both'
    };
    const genderMap = {
      '남': 'male', '여': 'female', '남자': 'male', '여자': 'female',
      'male': 'male', 'female': 'female', 'm': 'male', 'f': 'female'
    };

    const parseDate = (v) => {
      if (!v) return '';
      if (typeof v === 'number') {
        const d = XLSX.SSF.parse_date_code(v);
        return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
      }
      return String(v);
    };

    const getVal = (row, key) => {
      const idx = colMap[key];
      return idx >= 0 ? row[idx] : undefined;
    };

    const parseBool = (v) => {
      if (!v) return false;
      const s = String(v).toLowerCase().trim();
      return ['true', '1', 'o', 'yes', 'y', '예', '○', '유'].includes(s);
    };

    const parseKlg = (v) => {
      if (!v) return '';
      const s = String(v).trim();
      if (s === 'N/A' || s === '해당없음') return 'N/A';
      const m = s.match(/(\d)/);
      return m ? m[1] : '';
    };

    const applyKlg = (diag, side, klgRight, klgLeft) => {
      if (side === 'right' || side === 'both') diag.klgRight = klgRight;
      if (side === 'left' || side === 'both') diag.klgLeft = klgLeft;
    };

    let stats = { newPatients: 0, newDiagnoses: 0, newJobs: 0, skipped: 0 };

    // 기존 환자 복사 (신형식 기준)
    const resultPatients = existingPatients.map(p => ({
      ...p,
      data: {
        ...p.data,
        shared: { ...p.data.shared, diagnoses: [...(p.data.shared?.diagnoses || [])], jobs: [...(p.data.shared?.jobs || [])] },
        modules: {
          ...p.data.modules,
          ...(p.data.modules?.knee ? { knee: { ...p.data.modules.knee, jobExtras: [...(p.data.modules.knee.jobExtras || [])] } } : {})
        },
        activeModules: [...(p.data.activeModules || [])]
      }
    }));

    for (let i = 1; i < preview.length; i++) {
      const row = preview[i];
      if (!row || row.length === 0 || !getVal(row, 'name')) continue;

      const rowName = String(getVal(row, 'name') || '').trim();
      const rowBirthDate = parseDate(getVal(row, 'birthDate'));
      const rowDiagCode = String(getVal(row, 'diagCode') || '').trim();
      const rowDiagName = String(getVal(row, 'diagName') || '').trim();
      const rowSide = sideMap[(String(getVal(row, 'side') || '')).toLowerCase()] || '';
      const rowJobName = String(getVal(row, 'jobName') || '').trim();
      const rowKlgRight = parseKlg(getVal(row, 'klgRight'));
      const rowKlgLeft = parseKlg(getVal(row, 'klgLeft'));
      const rowInjuryDate = parseDate(getVal(row, 'injuryDate'));

      // 환자 찾기 (이름 + 생년월일 + 재해일자)
      let existingPatient = resultPatients.find(p =>
        p.data.shared.name === rowName &&
        p.data.shared.birthDate === rowBirthDate &&
        p.data.shared.injuryDate === rowInjuryDate
      );

      if (!existingPatient) {
        // 새 환자: 상병으로 모듈 자동 분류
        const diagList = [];
        if (rowDiagCode || rowDiagName) {
          const newDiag = { ...createDiagnosis(), code: rowDiagCode, name: rowDiagName, side: rowSide };
          applyKlg(newDiag, rowSide, rowKlgRight, rowKlgLeft);
          diagList.push(newDiag);
        }

        const suggestedMods = suggestModules(diagList);
        // 무릎 관련 직업 데이터가 있으면 knee 모듈 보장
        if (rowJobName && !suggestedMods.includes('knee')) {
          suggestedMods.push('knee');
        }

        const modulesData = {};
        for (const mId of suggestedMods) {
          const mod = getModule(mId);
          if (mod?.createModuleData) modulesData[mId] = mod.createModuleData();
        }

        const p = createPatient(suggestedMods, modulesData);
        p.data.shared.name = rowName;
        p.data.shared.birthDate = rowBirthDate;
        p.data.shared.injuryDate = rowInjuryDate;
        p.data.shared.height = getVal(row, 'height') ? String(getVal(row, 'height')) : '';
        p.data.shared.weight = getVal(row, 'weight') ? String(getVal(row, 'weight')) : '';
        p.data.shared.gender = genderMap[(String(getVal(row, 'gender') || '')).toLowerCase()] || '';
        p.data.shared.hospitalName = String(getVal(row, 'hospitalName') || '');
        p.data.shared.department = String(getVal(row, 'department') || '');
        p.data.shared.doctorName = String(getVal(row, 'doctorName') || '');
        p.data.shared.specialNotes = String(getVal(row, 'specialNotes') || '');
        if (diagList.length > 0) p.data.shared.diagnoses = diagList;

        // 직업 데이터 → shared.jobs + 무릎 jobExtras
        if (rowJobName) {
          const sharedJob = createSharedJob();
          sharedJob.jobName = rowJobName;
          sharedJob.startDate = parseDate(getVal(row, 'jobStart'));
          sharedJob.endDate = parseDate(getVal(row, 'jobEnd'));
          sharedJob.workPeriodOverride = (() => {
            const y = parseInt(getVal(row, 'jobPeriodY')) || 0;
            const m = parseInt(getVal(row, 'jobPeriodM')) || 0;
            if (!y && !m) return '';
            const imported = `${y}년 ${m}개월`;
            const auto = formatWorkPeriod(parseDate(getVal(row, 'jobStart')), parseDate(getVal(row, 'jobEnd')));
            return imported !== auto ? imported : '';
          })();
          p.data.shared.jobs = [sharedJob];

          if (modulesData.knee) {
            modulesData.knee.jobExtras = [{
              ...createKneeJobExtras(sharedJob.id),
              weight: getVal(row, 'jobWeight') ? String(getVal(row, 'jobWeight')) : '',
              squatting: getVal(row, 'jobSquat') ? String(getVal(row, 'jobSquat')) : '',
              stairs: parseBool(getVal(row, 'stairs')),
              kneeTwist: parseBool(getVal(row, 'kneeTwist')),
              startStop: parseBool(getVal(row, 'startStop')),
              tightSpace: parseBool(getVal(row, 'tightSpace')),
              kneeContact: parseBool(getVal(row, 'kneeContact')),
              jumpDown: parseBool(getVal(row, 'jumpDown'))
            }];
          }
        }

        // 무릎 모듈 복귀 고려사항
        if (modulesData.knee) {
          const returnVal = String(getVal(row, 'returnConsiderations') || '');
          if (returnVal) modulesData.knee.returnConsiderations = returnVal;
          p.data.modules.knee = modulesData.knee;
        }

        resultPatients.push(p);
        stats.newPatients++;
      } else {
        // 기존 환자 머지
        const existingDiag = existingPatient.data.shared.diagnoses.find(d =>
          d.code === rowDiagCode && d.name === rowDiagName && d.side === rowSide
        );

        if (!existingDiag && (rowDiagCode || rowDiagName)) {
          const newDiag = { ...createDiagnosis(), code: rowDiagCode, name: rowDiagName, side: rowSide };
          applyKlg(newDiag, rowSide, rowKlgRight, rowKlgLeft);
          existingPatient.data.shared.diagnoses.push(newDiag);
          stats.newDiagnoses++;

          // 새 상병으로 모듈 재분류
          const newSuggested = suggestModules(existingPatient.data.shared.diagnoses);
          for (const mId of newSuggested) {
            if (!existingPatient.data.activeModules.includes(mId)) {
              existingPatient.data.activeModules.push(mId);
              const mod = getModule(mId);
              if (mod?.createModuleData) existingPatient.data.modules[mId] = mod.createModuleData();
            }
          }
        } else if (existingDiag) {
          if (rowKlgRight && !existingDiag.klgRight && (rowSide === 'right' || rowSide === 'both')) {
            existingDiag.klgRight = rowKlgRight;
          }
          if (rowKlgLeft && !existingDiag.klgLeft && (rowSide === 'left' || rowSide === 'both')) {
            existingDiag.klgLeft = rowKlgLeft;
          }
        }

        // 직업 머지 (shared.jobs + 무릎 jobExtras)
        if (rowJobName) {
          const existingSharedJob = (existingPatient.data.shared.jobs || []).find(j => j.jobName === rowJobName);
          if (!existingSharedJob) {
            const sharedJob = createSharedJob();
            sharedJob.jobName = rowJobName;
            sharedJob.startDate = parseDate(getVal(row, 'jobStart'));
            sharedJob.endDate = parseDate(getVal(row, 'jobEnd'));
            sharedJob.workPeriodOverride = (() => {
              const y = parseInt(getVal(row, 'jobPeriodY')) || 0;
              const m = parseInt(getVal(row, 'jobPeriodM')) || 0;
              if (!y && !m) return '';
              const imported = `${y}년 ${m}개월`;
              const auto = formatWorkPeriod(parseDate(getVal(row, 'jobStart')), parseDate(getVal(row, 'jobEnd')));
              return imported !== auto ? imported : '';
            })();
            if (!existingPatient.data.shared.jobs) existingPatient.data.shared.jobs = [];
            existingPatient.data.shared.jobs.push(sharedJob);

            // 무릎 jobExtras 추가
            if (existingPatient.data.modules?.knee) {
              const kneeData = existingPatient.data.modules.knee;
              if (!kneeData.jobExtras) kneeData.jobExtras = [];
              kneeData.jobExtras.push({
                ...createKneeJobExtras(sharedJob.id),
                weight: getVal(row, 'jobWeight') ? String(getVal(row, 'jobWeight')) : '',
                squatting: getVal(row, 'jobSquat') ? String(getVal(row, 'jobSquat')) : '',
                stairs: parseBool(getVal(row, 'stairs')),
                kneeTwist: parseBool(getVal(row, 'kneeTwist')),
                startStop: parseBool(getVal(row, 'startStop')),
                tightSpace: parseBool(getVal(row, 'tightSpace')),
                kneeContact: parseBool(getVal(row, 'kneeContact')),
                jumpDown: parseBool(getVal(row, 'jumpDown'))
              });
            }
            stats.newJobs++;
          } else if (existingDiag) {
            stats.skipped++;
          }
        }
      }
    }

    if (stats.newPatients === 0 && stats.newDiagnoses === 0 && stats.newJobs === 0) {
      await showAlert('가져올 데이터가 없습니다 (모두 중복)');
      return;
    }

    onImport(resultPatients, stats);
    onClose();
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 600 }}>
        <h2>일괄 Import (다중 환자)</h2>

        <div
          className={`import-zone ${dragover ? 'dragover' : ''}`}
          onClick={() => fileRef.current.click()}
          onDragOver={e => { e.preventDefault(); setDragover(true); }}
          onDragLeave={() => setDragover(false)}
          onDrop={e => { e.preventDefault(); setDragover(false); handleFile(e.dataTransfer.files[0]); }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls,.csv"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
          <p>클릭하거나 파일을 드래그하세요</p>
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem', marginTop: 5 }}>
            첫 행: 컬럼명 / 2행부터: 환자별 데이터
          </p>
          {file && <p style={{ marginTop: 10, color: '#667eea' }}>선택됨: {file.name}</p>}
        </div>

        <details style={{ marginTop: 10, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
          <summary style={{ cursor: 'pointer' }}>지원하는 컬럼 (29개)</summary>
          <div style={{ marginTop: 8, padding: 10, background: 'var(--card-bg)', borderRadius: 4 }}>
            <strong>기본정보:</strong> 이름, 생년월일, 재해일자, 키, 몸무게, 성별<br/>
            <strong>기관정보:</strong> 병원명, 진료과, 담당의<br/>
            <strong>기타:</strong> 특이사항, 복귀고려사항<br/>
            <strong>상병:</strong> 진단코드, 진단명, 부위, KLG(우측), KLG(좌측)<br/>
            <strong>직업:</strong> 직종명, 시작일, 종료일, 근무기간(년), 근무기간(개월), 중량물(kg), 쪼그려앉기(분)<br/>
            <strong>보조변수:</strong> 계단오르내리기, 무릎비틀림, 출발정지반복, 좁은공간, 무릎접촉충격, 뛰어내리기
          </div>
        </details>

        {preview && preview.length > 1 && (
          <div style={{ marginTop: 12 }}>
            <h4>미리보기: {preview.length - 1}행</h4>
            <div style={{ overflowX: 'auto', marginTop: 10 }}>
              <table className="import-preview">
                <thead>
                  <tr>
                    {columns.slice(0, 8).map((c, i) => <th key={i}>{c}</th>)}
                    {columns.length > 8 && <th>...</th>}
                  </tr>
                </thead>
                <tbody>
                  {preview.slice(1, 6).map((row, ri) => (
                    <tr key={ri}>
                      {columns.slice(0, 8).map((_, ci) => <td key={ci}>{row[ci]}</td>)}
                      {columns.length > 8 && <td>...</td>}
                    </tr>
                  ))}
                  {preview.length > 6 && (
                    <tr>
                      <td colSpan={Math.min(columns.length, 9)} style={{ textAlign: 'center', color: 'var(--text-muted)' }}>
                        ... 외 {preview.length - 6}행
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, marginTop: 15 }}>
          <button className="btn btn-primary" onClick={handleImport} disabled={!preview}>
            일괄 가져오기
          </button>
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}
