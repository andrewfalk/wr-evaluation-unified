import { useMemo, useState } from 'react';
import { getStatusText } from '../../modules/knee/utils/calculations';
import { LOW_REASON_OPTIONS } from '../../modules/knee/utils/data';
import {
  assessmentLabel,
  buildAssessmentGroups,
  mergeDisplayTags,
  applyPatternToUnits,
  revertPatch,
} from '../utils/assessmentGroups';
import { AssessmentPatternEditor } from './AssessmentPatternEditor';

const CHIP_LIMIT = 6;

function summarizeBefore(units, byId, isIncomplete) {
  if (isIncomplete) return '미입력';
  const combos = new Set(units.map(u => {
    const diag = byId.get(u.diagId);
    return `${diag[u.confirmedKey] || '-'}|${diag[u.assessmentKey] || '-'}`;
  }));
  if (combos.size !== 1) return '혼합 (여러 값 존재)';
  const [confirmed, assessment] = [...combos][0].split('|');
  return `${getStatusText(confirmed)} / ${assessmentLabel(assessment)}`;
}

function GroupCard({
  groupKey, title, isIncomplete, reasonText, units, byId,
  expanded, onToggleExpand, splitDiagIds, onToggleSplit,
  selection, onToggleUnit, onToggleAll, onEditGroup, onEditSelection, onJumpToDiagnosis,
}) {
  const tags = useMemo(() => mergeDisplayTags(units, byId), [units, byId]);
  const visibleTags = tags.slice(0, CHIP_LIMIT);
  const restCount = tags.length - visibleTags.length;
  const selectedUnitIds = units.map(u => u.id).filter(id => selection.has(id));
  const selectedDiagCount = new Set(
    units.filter(u => selection.has(u.id)).map(u => u.diagId)
  ).size;
  const allUnitIds = units.map(u => u.id);
  const allSelected = allUnitIds.length > 0 && allUnitIds.every(id => selection.has(id));

  return (
    <div className={`assessment-group-card${isIncomplete ? ' incomplete' : ''}`}>
      <div className="assessment-group-card-head">
        <span className="assessment-group-card-title">{isIncomplete ? '⚠ ' : ''}{title}</span>
        <span className="assessment-group-card-count">{units.length}개</span>
      </div>
      {reasonText && <div className="assessment-group-reason">낮음 사유: {reasonText}</div>}
      <div className="assessment-group-chips">
        {visibleTags.map(tag => (
          <button
            key={tag.unitIds.join(',')}
            type="button"
            className="assessment-chip"
            onClick={() => onJumpToDiagnosis(tag.diagId)}
            title="개별 카드로 이동"
          >
            {tag.label}
          </button>
        ))}
        {restCount > 0 && <span className="assessment-chip more">+{restCount}</span>}
      </div>
      <div className="assessment-group-actions">
        <button type="button" className="btn btn-sm btn-secondary" onClick={onToggleExpand}>
          {expanded ? '▴ 구성원 접기' : '▾ 구성원 펼치기'}
        </button>
        <button type="button" className={`btn btn-sm ${isIncomplete ? 'btn-primary' : 'btn-secondary'}`} onClick={onEditGroup}>
          {isIncomplete ? '그룹 값 입력' : '그룹 전체 수정'}
        </button>
      </div>

      {expanded && (
        <div className="assessment-member-panel">
          <div className="assessment-member-toolbar">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={e => onToggleAll(allUnitIds, e.target.checked)}
              />
              전체 선택
            </label>
            <span className="assessment-member-selected">선택 {selectedUnitIds.length}개</span>
          </div>
          <div className="assessment-member-list">
            {tags.map(tag => {
              const diag = byId.get(tag.diagId);
              const splitOn = splitDiagIds.has(tag.diagId);
              if (tag.both && !splitOn) {
                const checked = tag.unitIds.every(id => selection.has(id));
                return (
                  <div className="assessment-member-row" key={tag.diagId}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => onToggleUnit(tag.unitIds, e.target.checked)}
                    />
                    <span className="assessment-member-code">{diag.code}</span>
                    <span className="assessment-member-name">{diag.name}</span>
                    <button type="button" className="assessment-side-badge both" onClick={() => onToggleSplit(tag.diagId)} title="우/좌 분리">
                      양측(우+좌)
                    </button>
                  </div>
                );
              }
              if (tag.both && splitOn) {
                return tag.unitIds.map((unitId, idx) => {
                  const sideLabel = idx === 0 ? '우' : '좌';
                  const cls = idx === 0 ? 'right' : 'left';
                  return (
                    <div className="assessment-member-row" key={unitId}>
                      <input type="checkbox" checked={selection.has(unitId)} onChange={e => onToggleUnit([unitId], e.target.checked)} />
                      <span className="assessment-member-code">{diag.code}</span>
                      <span className="assessment-member-name">{diag.name}</span>
                      <span className={`assessment-side-badge ${cls}`}>{sideLabel}</span>
                    </div>
                  );
                });
              }
              const unitId = tag.unitIds[0];
              const cls = tag.label.includes('(우)') ? 'right' : tag.label.includes('(좌)') ? 'left' : 'axial';
              const sideLabel = cls === 'right' ? '우' : cls === 'left' ? '좌' : '평가';
              return (
                <div className="assessment-member-row" key={unitId}>
                  <input type="checkbox" checked={selection.has(unitId)} onChange={e => onToggleUnit([unitId], e.target.checked)} />
                  <span className="assessment-member-code">{diag.code}</span>
                  <span className="assessment-member-name">{diag.name}</span>
                  <span className={`assessment-side-badge ${cls}`}>{sideLabel}</span>
                </div>
              );
            })}
          </div>
          <div className="assessment-member-footer">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={selectedUnitIds.length === 0}
              onClick={onEditSelection}
            >
              선택한 {selectedDiagCount}개(평가단위 {selectedUnitIds.length}개) 값 {isIncomplete ? '입력' : '변경'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AssessmentGroupView({ diagnoses, activeModules, onDiagnosesReplace, onJumpToDiagnosis }) {
  const info = useMemo(() => buildAssessmentGroups(diagnoses, activeModules), [diagnoses, activeModules]);
  // 방향(우/좌/양측) 미선택 진단 — buildAssessmentGroups.stats.incompleteCount에 이미
  // 합산되어 있으므로(assessmentGroups.js), 상단 통계 숫자와 아래 카드가 항상 일치한다.
  const unassignedSideDiagnoses = info.unassignedSideDiagnoses;

  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [splitMap, setSplitMap] = useState(() => new Map()); // groupKey -> Set(diagId)
  const [selectionMap, setSelectionMap] = useState(() => new Map()); // groupKey -> Set(unitId)
  const [editorState, setEditorState] = useState(null); // { key, isIncomplete, units, contextLabel }
  const [undoState, setUndoState] = useState(null); // { undoPatch, count }

  const toggleExpand = key => setExpandedKeys(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const toggleSplit = (key, diagId) => setSplitMap(prev => {
    const next = new Map(prev);
    const set = new Set(next.get(key) || []);
    if (set.has(diagId)) set.delete(diagId); else set.add(diagId);
    next.set(key, set);
    return next;
  });

  const toggleUnit = (key, unitIds, checked) => setSelectionMap(prev => {
    const next = new Map(prev);
    const set = new Set(next.get(key) || []);
    unitIds.forEach(id => (checked ? set.add(id) : set.delete(id)));
    next.set(key, set);
    return next;
  });

  const toggleAll = (key, unitIds, checked) => setSelectionMap(prev => {
    const next = new Map(prev);
    const set = new Set(checked ? unitIds : []);
    next.set(key, set);
    return next;
  });

  function openEditor(key, isIncomplete, units, contextLabel) {
    if (!units.length) return;
    const diagCount = new Set(units.map(u => u.diagId)).size;
    // 완료 그룹(및 그 부분집합)은 그룹 정의상 값이 이미 동일하므로 폼을 그 값으로
    // 채워 넣는다 — 한 항목만 바꾸려고 나머지 값을 처음부터 다시 고르지 않도록.
    let initialValues = { confirmed: '', assessment: '', reasons: [], other: '' };
    if (!isIncomplete) {
      const first = units[0];
      const diag = info.byId.get(first.diagId);
      const assessment = diag[first.assessmentKey] || '';
      initialValues = {
        confirmed: diag[first.confirmedKey] || '',
        assessment,
        reasons: assessment === 'low' ? (diag[first.reasonKey] || []) : [],
        other: assessment === 'low' ? (diag[first.reasonOtherKey] || '') : '',
      };
    }
    setEditorState({
      key, isIncomplete, units, diagCount,
      contextLabel,
      beforeText: summarizeBefore(units, info.byId, isIncomplete),
      initialValues,
    });
  }

  function applyEditor(patch) {
    if (!editorState) return;
    const { next, undoPatch } = applyPatternToUnits(diagnoses, editorState.units, patch);
    onDiagnosesReplace(next);
    setUndoState({ undoPatch, count: editorState.units.length });
    setEditorState(null);
  }

  function handleUndo() {
    if (!undoState) return;
    onDiagnosesReplace(revertPatch(diagnoses, undoState.undoPatch));
    setUndoState(null);
  }

  function renderCard(groupKey, title, isIncomplete, reasonText, units) {
    const selection = selectionMap.get(groupKey) || new Set();
    const splitDiagIds = splitMap.get(groupKey) || new Set();
    return (
      <GroupCard
        key={groupKey}
        groupKey={groupKey}
        title={title}
        isIncomplete={isIncomplete}
        reasonText={reasonText}
        units={units}
        byId={info.byId}
        expanded={expandedKeys.has(groupKey)}
        onToggleExpand={() => toggleExpand(groupKey)}
        splitDiagIds={splitDiagIds}
        onToggleSplit={diagId => toggleSplit(groupKey, diagId)}
        selection={selection}
        onToggleUnit={(unitIds, checked) => toggleUnit(groupKey, unitIds, checked)}
        onToggleAll={(unitIds, checked) => toggleAll(groupKey, unitIds, checked)}
        onEditGroup={() => openEditor(groupKey, isIncomplete, units, `${title} 그룹 전체`)}
        onEditSelection={() => {
          const selected = units.filter(u => selection.has(u.id));
          openEditor(groupKey, isIncomplete, selected, '선택한 평가단위');
        }}
        onJumpToDiagnosis={onJumpToDiagnosis}
      />
    );
  }

  return (
    <div className="assessment-group-view">
      <div className="assessment-group-stats">
        상병 {info.stats.diagnosisCount}건 · 평가단위 {info.stats.unitCount}개 · 패턴 {info.stats.groupCount}개 · 미완료 {info.stats.incompleteCount}개
      </div>

      {unassignedSideDiagnoses.length > 0 && (
        <div className="assessment-group-card incomplete">
          <div className="assessment-group-card-head">
            <span className="assessment-group-card-title">⚠ 방향 미선택 — 상병 입력에서 우측/좌측/양측을 먼저 선택하세요</span>
            <span className="assessment-group-card-count">{unassignedSideDiagnoses.length}건</span>
          </div>
          <div className="assessment-group-chips">
            {unassignedSideDiagnoses.map(({ diag, index }) => (
              <button
                key={diag.id}
                type="button"
                className="assessment-chip"
                onClick={() => onJumpToDiagnosis(diag.id)}
                title="개별 카드로 이동"
              >
                #{index + 1} {diag.code} {diag.name}
              </button>
            ))}
          </div>
        </div>
      )}

      {info.incomplete.length > 0 && renderCard('__incomplete__', '미입력 · 조치 필요', true, null, info.incomplete)}

      {info.groups.map(group => {
        const title = `${getStatusText(group.meta.confirmed)} · 업무관련성 ${assessmentLabel(group.meta.assessment)}`;
        const reasonText = group.meta.assessment === 'low'
          ? group.meta.reasons.map(r => lowReasonLabel(r)).join(', ') + (group.meta.other ? ` / 기타: ${group.meta.other}` : '')
          : null;
        return renderCard(group.key, title, false, reasonText, group.units);
      })}

      {!info.incomplete.length && !info.groups.length && !unassignedSideDiagnoses.length && (
        <div className="evaluation-empty-state">표시할 상병이 없습니다.</div>
      )}

      {undoState && (
        <div className="assessment-undo-bar">
          <span>↩ 방금 {undoState.count}개 평가단위를 변경했습니다.</span>
          <button type="button" className="btn btn-sm" onClick={handleUndo}>실행 취소</button>
        </div>
      )}

      {editorState && (
        <AssessmentPatternEditor
          contextLabel={editorState.contextLabel}
          diagCount={editorState.diagCount}
          unitCount={editorState.units.length}
          beforeText={editorState.beforeText}
          isIncomplete={editorState.isIncomplete}
          initialValues={editorState.initialValues}
          onCancel={() => setEditorState(null)}
          onApply={applyEditor}
        />
      )}
    </div>
  );
}

function lowReasonLabel(value) {
  return LOW_REASON_OPTIONS.find(o => o.value === value)?.label || value;
}
