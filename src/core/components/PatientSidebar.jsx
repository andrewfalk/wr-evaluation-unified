import { useEffect, useMemo, useRef, useState } from 'react';
import { getAllModules, getModule } from '../moduleRegistry';
import { isPatientComplete } from '../utils/patientCompletion';
import { formatBirthDate } from '../utils/data';
import { isRedactedPatientRecord } from '../services/patientRecords';

const DEFAULT_SORT_DIRECTION = {
  default: 'asc',
  name: 'asc',
  patientNo: 'asc',
  birthDate: 'asc',
  registrationDate: 'desc',
  evaluationDate: 'desc',
};

const ADVANCED_FILTER_DEFAULTS = {
  moduleFilter: 'all',
  jobFilter: '',
  registrationFrom: '',
  registrationTo: '',
  completionFrom: '',
  completionTo: '',
};

const DATE_INPUT_MIN = '1900-01-01';
const DATE_INPUT_MAX = '2099-12-31';

function formatShortDate(value) {
  if (!value) return '-';
  return String(value).slice(0, 10);
}

function normalizeWarningText(value) {
  return String(value || '').trim();
}

function getPatientIdentityKey(patient) {
  if (isRedactedPatientRecord(patient)) return null;
  const shared = patient?.data?.shared || {};
  const patientNo = normalizeWarningText(shared.patientNo);
  const birthDate = normalizeWarningText(shared.birthDate).slice(0, 10);
  if (!patientNo || !birthDate) return null;
  return `${patientNo}\u0000${birthDate}`;
}

export function buildPatientNameWarningMap(patients = []) {
  const groups = new Map();

  patients.forEach(patient => {
    const key = getPatientIdentityKey(patient);
    const name = normalizeWarningText(patient?.data?.shared?.name);
    if (!key || !name || !patient?.id) return;

    const group = groups.get(key) || { entries: [], names: new Map() };
    group.entries.push({ id: patient.id, name });
    group.names.set(name.toLocaleLowerCase('ko'), name);
    groups.set(key, group);
  });

  const warnings = new Map();
  groups.forEach(group => {
    if (group.names.size < 2) return;
    group.entries.forEach(entry => {
      const otherName = group.entries.find(candidate => candidate.name !== entry.name)?.name || '';
      warnings.set(entry.id, {
        code: 'PATIENT_NAME_MISMATCH',
        message: 'Same patient number and birth date, but the name differs.',
        existingName: otherName,
        incomingName: entry.name,
      });
    });
  });

  return warnings;
}

function getPatientNameWarning(patient, warningMap) {
  const warnings = Array.isArray(patient?.sync?.warnings) ? patient.sync.warnings : [];
  return warnings.find(warning => warning?.code === 'PATIENT_NAME_MISMATCH')
    || warningMap?.get(patient?.id)
    || null;
}

function JobFilterCombobox({ patients, value, onChange }) {
  const [showList, setShowList] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const containerRef = useRef(null);
  const itemRefs = useRef([]);

  const allJobNames = useMemo(() => {
    const names = new Set();
    patients.forEach(p => {
      (p.data?.shared?.jobs || []).forEach(j => {
        const n = (j.jobName || '').trim();
        if (n) names.add(n);
      });
    });
    return [...names].sort((a, b) => a.localeCompare(b, 'ko'));
  }, [patients]);

  const suggestions = useMemo(() => {
    if (!value.trim()) return [];
    const q = value.trim().toLowerCase();
    return allJobNames.filter(n => n.toLowerCase().includes(q)).slice(0, 10);
  }, [allJobNames, value]);

  useEffect(() => {
    const handleClick = e => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setShowList(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (activeIndex >= 0) itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleChange = e => {
    onChange(e.target.value);
    setActiveIndex(-1);
    setShowList(true);
  };

  const handleKeyDown = e => {
    if (!showList || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, suggestions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      onChange(suggestions[activeIndex]);
      setShowList(false);
      setActiveIndex(-1);
    } else if (e.key === 'Escape') {
      setShowList(false);
      setActiveIndex(-1);
    }
  };

  const visible = showList && suggestions.length > 0;

  return (
    <div className="search-container" ref={containerRef}>
      <input
        type="search"
        placeholder="직종명 입력..."
        value={value}
        onChange={handleChange}
        onFocus={() => { if (suggestions.length) setShowList(true); }}
        onKeyDown={handleKeyDown}
        aria-autocomplete="list"
        aria-expanded={visible}
      />
      {visible && (
        <div className="search-results">
          {suggestions.map((name, i) => (
            <div
              key={name}
              ref={el => { itemRefs.current[i] = el; }}
              className={`search-item${i === activeIndex ? ' is-active' : ''}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => { onChange(name); setShowList(false); setActiveIndex(-1); }}
            >
              <div className="search-item-name">{name}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function PatientSidebar({
  showSidebar,
  onClose,
  patients,
  displayPatients,
  activeId,
  filters,
  setFilters,
  selectedIds,
  setSelectedIds,
  onAddPatient,
  onShowBatchImport,
  onSwitchPatient,
  onRemovePatient,
  onRemoveSelectedPatients,
  onResolveConflict,
  scope = 'mine',
  onScopeChange,
  session,
}) {
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false);
  const allModules = useMemo(() => getAllModules(), []);
  const nameWarningMap = useMemo(() => buildPatientNameWarningMap(patients), [patients]);

  const {
    searchQuery = '',
    statusFilter = 'all',
    moduleFilter = 'all',
    jobFilter = 'all',
    registrationFrom = '',
    registrationTo = '',
    completionFrom = '',
    completionTo = '',
    sortKey = 'default',
    sortDirection = 'asc',
  } = filters || {};

  const updateFilter = (key, value, { keepSelection = false } = {}) => {
    setFilters(prev => ({ ...prev, [key]: value }));
    if (!keepSelection) setSelectedIds(new Set());
  };

  const handleSortKeyChange = (value) => {
    setFilters(prev => ({
      ...prev,
      sortKey: value,
      sortDirection: DEFAULT_SORT_DIRECTION[value] || 'asc',
    }));
  };

  const toggleSortDirection = () => {
    updateFilter('sortDirection', sortDirection === 'desc' ? 'asc' : 'desc', { keepSelection: true });
  };

  const resetAdvancedFilters = () => {
    setFilters(prev => ({ ...prev, ...ADVANCED_FILTER_DEFAULTS }));
    setSelectedIds(new Set());
  };

  const activeAdvancedFilterCount = [
    moduleFilter !== 'all',
    Boolean(jobFilter.trim()),
    Boolean(registrationFrom),
    Boolean(registrationTo),
    Boolean(completionFrom),
    Boolean(completionTo),
  ].filter(Boolean).length;

  const hasVisibleFilter = searchQuery.trim() || statusFilter !== 'all' || activeAdvancedFilterCount > 0;

  return (
    <>
      {showSidebar && <div className="sidebar-overlay" onClick={onClose} />}

      <div className={`sidebar ${showSidebar ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <h2>환자 목록 ({hasVisibleFilter ? `${displayPatients.length}/${patients.length}` : patients.length})</h2>
          <div className="sidebar-actions">
            <button className="btn btn-primary btn-sm" onClick={onAddPatient} title="새 환자 추가">+ 추가</button>
            <button className="btn btn-info btn-sm" onClick={onShowBatchImport} title="엑셀 일괄입력">일괄</button>
          </div>
        </div>

        <div className="sidebar-filter">
          {session?.mode === 'intranet' && (
            <div className="patient-scope-toggle">
              <button
                className={`patient-scope-btn${scope === 'mine' ? ' patient-scope-btn--active' : ''}`}
                onClick={() => onScopeChange?.('mine')}
              >내 담당</button>
              <button
                className={`patient-scope-btn${scope === 'all' ? ' patient-scope-btn--active' : ''}`}
                onClick={() => onScopeChange?.('all')}
              >전체</button>
            </div>
          )}

          <input
            type="search"
            placeholder="검색..."
            title="이름, 등록번호, 진단, 직종 검색"
            value={searchQuery}
            onChange={e => updateFilter('searchQuery', e.target.value)}
          />

          <div className="sidebar-selection-row">
            <input
              type="checkbox"
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
            <select value={statusFilter} onChange={e => updateFilter('statusFilter', e.target.value)}>
              <option value="all">전체</option>
              <option value="complete">완료</option>
              <option value="incomplete">미완료</option>
            </select>
            <select value={sortKey} onChange={e => handleSortKeyChange(e.target.value)}>
              <option value="default">입력순</option>
              <option value="name">이름순</option>
              <option value="patientNo">등록번호순</option>
              <option value="birthDate">생년월일순</option>
              <option value="registrationDate">등록일순</option>
              <option value="evaluationDate">완료일순</option>
            </select>
            <button
              type="button"
              className="sort-dir-btn"
              onClick={toggleSortDirection}
              title={sortDirection === 'desc' ? '내림차순' : '오름차순'}
            >
              {sortDirection === 'desc' ? '▼' : '▲'}
            </button>
          </div>

          <button
            type="button"
            className="filter-toggle-btn"
            onClick={() => setShowAdvancedFilters(v => !v)}
          >
            필터 {showAdvancedFilters ? '▲' : '▼'}
            {activeAdvancedFilterCount > 0 && <span className="active-filter-badge">{activeAdvancedFilterCount}</span>}
          </button>

          {showAdvancedFilters && (
            <div className="sidebar-filter-advanced">
              <label className="sidebar-filter-field">
                <span>모듈</span>
                <select value={moduleFilter} onChange={e => updateFilter('moduleFilter', e.target.value)}>
                  <option value="all">전체 모듈</option>
                  {allModules.map(module => (
                    <option key={module.id} value={module.id}>{module.name}</option>
                  ))}
                </select>
              </label>

              <div className="sidebar-filter-field">
                <span>직종</span>
                <JobFilterCombobox
                  patients={patients}
                  value={jobFilter}
                  onChange={v => updateFilter('jobFilter', v)}
                />
              </div>

              <div className="sidebar-date-filter">
                <span>등록일</span>
                <div className="sidebar-date-row">
                  <input type="date" min={DATE_INPUT_MIN} max={DATE_INPUT_MAX} value={registrationFrom} onChange={e => updateFilter('registrationFrom', e.target.value)} />
                  <input type="date" min={DATE_INPUT_MIN} max={DATE_INPUT_MAX} value={registrationTo} onChange={e => updateFilter('registrationTo', e.target.value)} />
                </div>
              </div>

              <div className="sidebar-date-filter">
                <span>완료일</span>
                <div className="sidebar-date-row">
                  <input type="date" min={DATE_INPUT_MIN} max={DATE_INPUT_MAX} value={completionFrom} onChange={e => updateFilter('completionFrom', e.target.value)} />
                  <input type="date" min={DATE_INPUT_MIN} max={DATE_INPUT_MAX} value={completionTo} onChange={e => updateFilter('completionTo', e.target.value)} />
                </div>
              </div>

              <button type="button" className="btn btn-secondary btn-xs" onClick={resetAdvancedFilters}>필터 초기화</button>
            </div>
          )}
        </div>

        <div className="patient-list">
          {displayPatients.map(p => {
            const origIndex = patients.indexOf(p);
            const isRedacted = isRedactedPatientRecord(p);
            const pModules = p.data?.activeModules || [];
            const isComplete = !isRedacted && isPatientComplete(p);
            const patientName = isRedacted ? '삭제된 환자' : (p.data?.shared?.name || `환자 #${origIndex + 1}`);
            const patientNo = p.data?.shared?.patientNo || '';
            const registrationDate = formatShortDate(p.createdAt || p._savedAt);
            const evaluationDate = formatShortDate(p.data?.shared?.evaluationDate);
            const primaryDiagnosis = isRedacted ? '개인정보 삭제됨' : (p.data?.shared?.diagnoses?.[0]?.name || '-');
            const hasConflict = p.sync?.syncStatus === 'conflict';
            const conflictKind = p.sync?.conflict?.kind || 'conflict';
            const nameWarning = getPatientNameWarning(p, nameWarningMap);
            const nameWarningTitle = nameWarning
              ? `같은 등록번호와 생년월일의 기존 이름(${nameWarning.existingName || '-'})과 현재 이름(${nameWarning.incomingName || patientName})이 다릅니다. 개명 또는 입력 오류인지 확인하세요.`
              : '';

            return (
              <div key={p.id} className={`patient-item ${p.id === activeId ? 'active' : ''} ${hasConflict ? 'conflict' : ''} ${isRedacted ? 'redacted' : ''}`} onClick={() => onSwitchPatient(p.id)}>
                <div className="patient-item-grid">
                  <div className="patient-item-select">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(p.id)}
                      onClick={e => e.stopPropagation()}
                      onChange={() => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          next.has(p.id) ? next.delete(p.id) : next.add(p.id);
                          return next;
                        });
                      }}
                    />
                  </div>
                  <div className="patient-item-content">
                    <div className="patient-item-top">
                      <div className="patient-item-name-row">
                        <span className="patient-item-title">{patientName}</span>
                        {patientNo && <span className="patient-no">#{patientNo}</span>}
                        {isRedacted && <span className="patient-sync-badge patient-sync-badge-redacted">삭제됨</span>}
                        {hasConflict && <span className="patient-sync-badge">{conflictKind}</span>}
                        {nameWarning && <span className="patient-sync-badge patient-sync-badge-warning" title={nameWarningTitle}>이름 확인</span>}
                        {scope === 'all' && session?.mode === 'intranet' && !p.assignedDoctorUserId && (
                          <span
                            className="patient-unassigned-badge"
                            title={p.sync?.assignmentWarnings?.length
                              ? p.sync.assignmentWarnings.map(w => w.message).join('\n')
                              : undefined}
                          >미배정</span>
                        )}
                        {scope === 'all' && session?.mode === 'intranet' && p.assignedDoctorUserId && p.assignedDoctorUserId !== session?.user?.id && (
                          <span className="patient-others-badge">타 담당</span>
                        )}
                        <div className="patient-item-modules">
                          {pModules.map(mId => {
                            const mod = getModule(mId);
                            return <span key={mId} className="module-badge" title={mod?.name}>{mod?.icon || '?'}</span>;
                          })}
                        </div>
                      </div>
                      <span className={isRedacted ? 'status-dot redacted' : (isComplete ? 'status-dot complete' : 'status-dot')} title={isRedacted ? '삭제된 환자' : (isComplete ? '완료' : '미완료')}>{isRedacted ? '삭제' : '●'}</span>
                    </div>
                    <div className="patient-item-info patient-item-meta">
                      <span>{formatBirthDate(p.data?.shared?.birthDate)}</span>
                      <span className="patient-item-divider">•</span>
                      <span className="patient-item-diagnosis">{primaryDiagnosis}</span>
                    </div>
                    <div className="patient-item-dates">
                      <span>등록 {registrationDate}</span>
                      <span>완료 {evaluationDate}</span>
                    </div>
                    <div className="patient-item-actions">
                      {hasConflict && (
                        <button className="btn btn-info btn-xs" onClick={e => { e.stopPropagation(); onResolveConflict?.(p.id); }}>Resolve</button>
                      )}
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
