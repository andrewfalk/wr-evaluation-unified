import { useRef, useState } from 'react';
import type { RefObject } from 'react';
import { readFirstSheetRows } from '../utils/xlsxIo';
import { useAuth } from '../auth/AuthContext';
import { showAlert, showConfirm } from '../utils/platform';
import { collectImportDateErrors } from '../utils/batchImportHelpers';
import { runBatchImport } from '../services/batchImport';
import type { BatchImportChange, BatchImportStats, ImportPatient } from '../services/batchImport';
import { loadChunk } from '../utils/loadChunk';
import { IMPORT_FIELD_GROUPS } from './batchImportGuide';

/** collectImportDateErrors(utils/batchImportHelpers.js)가 돌려주는 날짜 오류 한 건. */
interface ImportDateError {
  rowIndex: number;
  rowLabel: number;
  name: string;
  field: string;
  rawValue: string;
  message: string;
}

export interface BatchImportModalProps {
  onClose(): void;
  onImport(result: { newPatients: ImportPatient[]; changed: BatchImportChange[] }, stats: BatchImportStats): void;
  existingPatients?: readonly ImportPatient[];
}

const IMPORT_FIELD_COUNT = IMPORT_FIELD_GROUPS.reduce((sum, group) => sum + group.fields.length, 0);

export function BatchImportModal({ onClose, onImport, existingPatients = [] }: BatchImportModalProps) {
  const { session } = useAuth();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<unknown[][] | null>(null);
  const [columns, setColumns] = useState<unknown[]>([]);
  const [dragover, setDragover] = useState(false);
  // 미리보기 단계에서 검출한 날짜 오류. 기본적으로 가져오기를 차단하고,
  // 사용자가 명시적으로 확인한 경우에만(allowPartialImport) 정상 행만 반영한다.
  const [rowErrors, setRowErrors] = useState<ImportDateError[]>([]);
  const [allowPartialImport, setAllowPartialImport] = useState(false);
  const fileRef = useRef<HTMLInputElement>();

  const errorRowIndexes = new Set(rowErrors.map(e => e.rowIndex));
  const blockedByErrors = rowErrors.length > 0 && !allowPartialImport;

  const handleDownloadTemplate = async () => {
    try {
      const { exportBatchTemplate } = await loadChunk(() => import('../utils/exportService'));
      exportBatchTemplate();
    } catch (err) { await showAlert((err as Error).message); }
  };

  const handleFile = (selectedFile: File | undefined) => {
    if (!selectedFile) return;
    setFile(selectedFile);
    // 새 파일을 고르면 이전 파일의 오류/부분허용 상태가 남지 않도록 초기화한다.
    setRowErrors([]);
    setAllowPartialImport(false);

    const reader = new FileReader();
    reader.onload = event => {
      try {
        const rows = readFirstSheetRows((event.target as FileReader).result);
        if (rows.length > 0) {
          setPreview(rows);
          setColumns(rows[0]);
          // 사전검증은 반드시 여기서 — handleImport는 정상 행이 있으면 곧바로 모달을
          // 닫으므로 그 안에서 오류를 setState 해도 사용자가 볼 수 없다.
          setRowErrors(collectImportDateErrors(rows));
        }
      } catch (error) {
        showAlert(`파일 읽기 오류: ${(error as Error).message}`);
      }
    };
    reader.readAsArrayBuffer(selectedFile);
  };

  const handleAllowPartial = async () => {
    const ok = await showConfirm(
      `날짜 오류가 있는 ${rowErrors.length}개 항목을 제외하고 정상 행만 가져옵니다.\n`
      + `제외된 행의 데이터는 반영되지 않습니다.\n\n계속하시겠습니까?`
    );
    if (ok) setAllowPartialImport(true);
  };

  const handleImport = async () => {
    if (!preview || preview.length < 2) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }
    // 방어적 재확인 — 버튼이 비활성화돼 있지만 호출부가 바뀌어도 오염 데이터가 새지 않게.
    if (blockedByErrors) {
      await showAlert('날짜 오류가 있는 행이 있습니다. 파일을 수정하거나 "정상 행만 가져오기"를 선택하세요.');
      return;
    }

    // 행 → 새 환자·기존 환자 변경 계산은 runBatchImport(src/core/services/batchImport.ts, P2-56)가 한다.
    const { newPatients, changed, stats, empty } = runBatchImport({
      rows: preview, existingPatients, errorRowIndexes, session,
    });
    if (empty) {
      await showAlert('가져올 데이터가 없습니다.');
      return;
    }
    onImport({ newPatients, changed }, stats);
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
              <p className="modal-section-description">첫 행은 컬럼명, 두 번째 행부터 실제 데이터로 해석합니다. 형식이 처음이면 빈 양식을 받아 작성하세요.</p>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleDownloadTemplate}>빈 양식 다운로드</button>
            {file && <span className="modal-section-badge">{file.name}</span>}
          </div>

          <div
            className={`import-zone ${dragover ? 'dragover' : ''}`}
            onClick={() => (fileRef.current as HTMLInputElement).click()}
            onDragOver={event => { event.preventDefault(); setDragover(true); }}
            onDragLeave={() => setDragover(false)}
            onDrop={event => {
              event.preventDefault();
              setDragover(false);
              handleFile(event.dataTransfer.files[0]);
            }}
          >
            <input
              ref={fileRef as RefObject<HTMLInputElement>}
              type="file"
              accept=".xlsx,.xls,.csv"
              style={{ display: 'none' }}
              onChange={event => handleFile((event.target.files as FileList)[0])}
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

            {rowErrors.length > 0 && (
              <div className="conflict-notice conflict-notice-warning">
                <strong>날짜 오류 {rowErrors.length}건 — 가져오기가 차단되었습니다.</strong>
                <p className="modal-section-description">
                  엑셀에서 생년월일/재해일자 셀이 날짜가 아닌 텍스트 서식이면 잘못된 값이 그대로 저장돼
                  이후 수정이 막힐 수 있습니다. 파일을 수정한 뒤 다시 선택하세요.
                </p>
                <ul className="import-reference-list">
                  {rowErrors.map(err => (
                    <li key={`${err.rowIndex}-${err.field}`}>
                      {err.rowLabel}행: {err.name} — {err.field} &lsquo;{err.rawValue}&rsquo; ({err.message})
                    </li>
                  ))}
                </ul>
                {allowPartialImport
                  ? <p className="modal-section-description">위 행을 제외하고 가져옵니다.</p>
                  : (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={handleAllowPartial}>
                      오류 행 제외하고 정상 행만 가져오기
                    </button>
                  )}
              </div>
            )}
          </section>
        )}

        <div className="modal-actions">
          <button
            className="btn btn-primary"
            onClick={handleImport}
            disabled={!preview || blockedByErrors}
          >
            가져오기
          </button>
          <button className="btn btn-secondary" onClick={onClose}>취소</button>
        </div>
      </div>
    </div>
  );
}
