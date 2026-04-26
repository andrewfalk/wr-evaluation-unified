import { getModule } from '../moduleRegistry';
import { isPatientComplete } from '../utils/patientCompletion';
import { formatBirthDate } from '../utils/data';

export function PatientSidebar({
  showSidebar,
  onClose,
  patients,
  displayPatients,
  activeId,
  searchQuery,
  onSearchChange,
  statusFilter,
  onStatusFilterChange,
  sortKey,
  onSortKeyChange,
  selectedIds,
  setSelectedIds,
  onAddPatient,
  onShowBatchImport,
  onSwitchPatient,
  onRemovePatient,
  onRemoveSelectedPatients,
}) {
  return (
    <>
      {showSidebar && <div className="sidebar-overlay" onClick={onClose} />}

      <div className={`sidebar ${showSidebar ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <h2>환자 목록 ({(searchQuery.trim() || statusFilter !== 'all') ? `${displayPatients.length}/${patients.length}` : patients.length})</h2>
          <div className="sidebar-actions">
            <button className="btn btn-primary btn-sm" onClick={onAddPatient} title="새 환자 추가">+ 추가</button>
            <button className="btn btn-info btn-sm" onClick={onShowBatchImport} title="엑셀 일괄입력">일괄</button>
          </div>
        </div>
        <div className="sidebar-filter">
          <input type="search" placeholder="검색 (이름, 진단)" value={searchQuery} onChange={onSearchChange} />
          <div className="sidebar-selection-row">
            <input type="checkbox"
              checked={displayPatients.length > 0 && displayPatients.every(p => selectedIds.has(p.id))}
              onChange={e => {
                setSelectedIds(prev => {
                  const next = new Set(prev);
                  displayPatients.forEach(p => e.target.checked ? next.add(p.id) : next.delete(p.id));
                  return next;
                });
              }}
            />
            <span className="sidebar-selection-label">전체선택{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}</span>
            {selectedIds.size > 0 && <button className="btn btn-danger btn-xs sidebar-selection-delete" onClick={onRemoveSelectedPatients}>삭제</button>}
          </div>
          <div className="sidebar-filter-row">
            <select value={statusFilter} onChange={onStatusFilterChange}>
              <option value="all">전체</option><option value="complete">완료</option><option value="incomplete">미완료</option>
            </select>
            <select value={sortKey} onChange={onSortKeyChange}>
              <option value="default">입력순</option><option value="name">이름순</option><option value="birthDate">생년월일순</option><option value="evaluationDate">평가일순</option>
            </select>
          </div>
        </div>
        <div className="patient-list">
          {displayPatients.map(p => {
            const origIndex = patients.indexOf(p);
            const pModules = p.data.activeModules || [];
            const isComplete = isPatientComplete(p);
            const patientName = p.data.shared?.name || `환자 #${origIndex + 1}`;
            const primaryDiagnosis = p.data.shared?.diagnoses?.[0]?.name || '-';
            return (
              <div key={p.id} className={`patient-item ${p.id === activeId ? 'active' : ''}`} onClick={() => onSwitchPatient(p.id)}>
                <div className="patient-item-grid">
                  <div className="patient-item-select">
                    <input type="checkbox" checked={selectedIds.has(p.id)} onClick={e => e.stopPropagation()} onChange={() => {
                      setSelectedIds(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next; });
                    }} />
                  </div>
                  <div className="patient-item-content">
                    <div className="patient-item-top">
                      <div className="patient-item-name-row">
                        <span className="patient-item-title">{patientName}</span>
                        <div className="patient-item-modules">
                          {pModules.map(mId => { const mod = getModule(mId); return <span key={mId} className="module-badge" title={mod?.name}>{mod?.icon || '?'}</span>; })}
                        </div>
                      </div>
                      <span className={isComplete ? 'status-dot complete' : 'status-dot'} title={isComplete ? '완료' : '미완료'}>✓</span>
                    </div>
                    <div className="patient-item-info patient-item-meta">
                      <span>{formatBirthDate(p.data.shared?.birthDate)}</span>
                      <span className="patient-item-divider">•</span>
                      <span className="patient-item-diagnosis">{primaryDiagnosis}</span>
                    </div>
                    <div className="patient-item-actions">
                      <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); onRemovePatient(p.id); }}>삭제</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
