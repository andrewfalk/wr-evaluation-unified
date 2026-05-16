import { useMemo, useState } from 'react';
import { getModule } from '../moduleRegistry';
import { getPresetCategory, getPresetDescription } from '../services/presetRepository';

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function PresetModules({ modules }) {
  const ids = Object.keys(modules || {});
  if (!ids.length) return null;

  return (
    <div className="preset-browse-modules">
      {ids.map(moduleId => (
        <span key={moduleId} className="preset-badge">
          {getModule(moduleId)?.name || moduleId}
        </span>
      ))}
    </div>
  );
}

function getPresetKey(preset) {
  return preset?._customId || preset?.id;
}

export function PresetBrowseModal({ job, presets, onSelect, onDelete, onEdit, onClose }) {
  const [selectedId, setSelectedId] = useState(null);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [moduleFilter, setModuleFilter] = useState([]);

  const jobName = job?.jobName || '';
  const normalizedJobName = normalizeText(jobName);
  const normalizedQuery = normalizeText(query);

  const availableCategories = useMemo(() => (
    Array.from(new Set((presets || []).map(preset => getPresetCategory(preset)).filter(Boolean)))
      .sort((left, right) => left.localeCompare(right, 'ko'))
  ), [presets]);

  const availableModules = useMemo(() => {
    const ids = new Set();
    for (const preset of presets || []) {
      Object.keys(preset.modules || {}).forEach(moduleId => ids.add(moduleId));
    }

    return Array.from(ids).sort((left, right) => {
      const leftName = getModule(left)?.name || left;
      const rightName = getModule(right)?.name || right;
      return leftName.localeCompare(rightName, 'ko');
    });
  }, [presets]);

  const toggleModuleFilter = (moduleId) => {
    setModuleFilter(prev => (
      prev.includes(moduleId)
        ? prev.filter(id => id !== moduleId)
        : [...prev, moduleId]
    ));
  };

  const browseItems = useMemo(() => {
    return [...(presets || [])]
      .filter(preset => {
        const category = getPresetCategory(preset) || '';
        const description = getPresetDescription(preset) || '';
        const source = preset.source === 'custom' || preset._customId ? 'custom' : 'builtin';
        const moduleIds = Object.keys(preset.modules || {});
        const haystack = [preset.jobName, category, description].map(normalizeText).join(' ');

        if (normalizedQuery && !haystack.includes(normalizedQuery)) return false;
        if (categoryFilter !== 'all' && category !== categoryFilter) return false;
        if (sourceFilter !== 'all' && source !== sourceFilter) return false;
        if (moduleFilter.length > 0 && !moduleFilter.every(moduleId => moduleIds.includes(moduleId))) return false;

        return true;
      })
      .sort((left, right) => {
        const leftExact = normalizeText(left.jobName) === normalizedJobName ? 1 : 0;
        const rightExact = normalizeText(right.jobName) === normalizedJobName ? 1 : 0;
        if (rightExact !== leftExact) return rightExact - leftExact;

        const leftCustom = left.source === 'custom' || left._customId ? 1 : 0;
        const rightCustom = right.source === 'custom' || right._customId ? 1 : 0;
        if (rightCustom !== leftCustom) return rightCustom - leftCustom;

        return left.jobName.localeCompare(right.jobName, 'ko');
      });
  }, [categoryFilter, moduleFilter, normalizedJobName, normalizedQuery, presets, sourceFilter]);

  const selectedPreset = browseItems.find(item => getPresetKey(item) === selectedId) || null;
  const exactMatchCount = browseItems.filter(item => normalizeText(item.jobName) === normalizedJobName).length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal preset-browse-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>{"\uD504\uB9AC\uC14B \uC870\uD68C"}</h2>
            <p className="modal-section-description">
              {jobName
                ? `"${jobName}" \uC9C1\uB825\uC5D0 \uC801\uC6A9\uD560 \uD504\uB9AC\uC14B\uC744 \uACE0\uB974\uC138\uC694.`
                : "\uC801\uC6A9\uD560 \uD504\uB9AC\uC14B\uC744 \uACE0\uB974\uC138\uC694."}
            </p>
          </div>
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">{"\uAC80\uC0C9 \uBC0F \uD544\uD130"}</div>
          <div className="preset-browse-toolbar">
            <div className="form-group form-group-wide">
              <label>{"\uAC80\uC0C9\uC5B4"}</label>
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder={"\uC9C1\uC885\uBA85, \uCE74\uD14C\uACE0\uB9AC, \uC124\uBA85 \uAC80\uC0C9"}
              />
            </div>
            <div className="form-group">
              <label>{"\uCE74\uD14C\uACE0\uB9AC"}</label>
              <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)}>
                <option value="all">{"\uC804\uCCB4"}</option>
                {availableCategories.map(category => (
                  <option key={category} value={category}>{category}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>{"\uC18C\uC2A4"}</label>
              <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}>
                <option value="all">{"\uC804\uCCB4"}</option>
                <option value="custom">{"\uB0B4 \uD504\uB9AC\uC14B"}</option>
                <option value="builtin">{"\uAE30\uBCF8 \uD504\uB9AC\uC14B"}</option>
              </select>
            </div>
          </div>

          {availableModules.length > 0 && (
            <div className="preset-browse-filter-group">
              <div className="preset-browse-filter-label">{"\uBAA8\uB4C8 \uD544\uD130"}</div>
              <div className="preset-browse-chip-row">
                {availableModules.map(moduleId => {
                  const active = moduleFilter.includes(moduleId);
                  return (
                    <button
                      key={moduleId}
                      type="button"
                      className={`preset-browse-chip ${active ? 'is-active' : ''}`}
                      onClick={() => toggleModuleFilter(moduleId)}
                    >
                      {getModule(moduleId)?.name || moduleId}
                    </button>
                  );
                })}
                {moduleFilter.length > 0 && (
                  <button
                    type="button"
                    className="preset-browse-chip"
                    onClick={() => setModuleFilter([])}
                  >
                    {"\uD544\uD130 \uCD08\uAE30\uD654"}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">{"\uBAA9\uB85D \uC694\uC57D"}</div>
          <div className="preset-browse-summary">
            <span className="preset-browse-summary-item">
              {`\uD544\uD130 \uACB0\uACFC ${browseItems.length}\uAC74`}
            </span>
            {jobName && (
              <span className="preset-browse-summary-item">
                {`\uB3D9\uC77C \uC9C1\uC885\uBA85 ${exactMatchCount}\uAC74`}
              </span>
            )}
          </div>
          <div className="settings-inline-hint">
            {"\uD604\uC7AC \uC9C1\uC885\uBA85\uACFC \uAC19\uC740 \uD504\uB9AC\uC14B, \uADF8 \uB2E4\uC74C \uB0B4 \uD504\uB9AC\uC14B \uC21C\uC73C\uB85C \uC704\uC5D0 \uBC30\uCE58\uD569\uB2C8\uB2E4."}
          </div>
        </div>

        <div className="settings-section modal-section pattern-surface">
          <div className="settings-section-title">{"\uD504\uB9AC\uC14B \uBAA9\uB85D"}</div>
          {browseItems.length > 0 ? (
            <div className="preset-browse-list">
              {browseItems.map(preset => {
                const isSelected = getPresetKey(preset) === selectedId;
                const isExact = normalizeText(preset.jobName) === normalizedJobName;
                const isCustom = preset.source === 'custom' || preset._customId;

                return (
                  <div
                    key={getPresetKey(preset)}
                    className={`preset-browse-item ${isSelected ? 'is-selected' : ''}`}
                  >
                    <button
                      type="button"
                      className="preset-browse-item-main"
                      onClick={() => setSelectedId(getPresetKey(preset))}
                    >
                      <div className="preset-browse-item-top">
                        <span className="preset-list-name">{preset.jobName}</span>
                        <div className="preset-browse-badges">
                          {isExact && <span className="preset-badge">{"\uD604\uC7AC \uC9C1\uB825"}</span>}
                          {isCustom && <span className="preset-custom-tag">{"\uB0B4 \uD504\uB9AC\uC14B"}</span>}
                        </div>
                      </div>
                      <div className="preset-list-category">{getPresetCategory(preset)}</div>
                      {!!getPresetDescription(preset) && (
                        <div className="preset-list-description">{getPresetDescription(preset)}</div>
                      )}
                      <PresetModules modules={preset.modules} />
                    </button>
                    {isCustom && onDelete && (
                      <div className="preset-browse-item-actions">
                        {onEdit && (
                          <button
                            type="button"
                            className="btn btn-xs btn-secondary"
                            onClick={(event) => {
                              event.stopPropagation();
                              onEdit(preset);
                            }}
                          >
                            {"\uC218\uC815"}
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-xs btn-danger"
                          onClick={async (event) => {
                            event.stopPropagation();
                            const deleted = await onDelete(preset);
                            if (deleted && selectedId === getPresetKey(preset)) {
                              setSelectedId(null);
                            }
                          }}
                        >
                          {"\uC0AD\uC81C"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="preset-empty-notice">
              {"\uC870\uAC74\uC5D0 \uB9DE\uB294 \uD504\uB9AC\uC14B\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."}
            </div>
          )}
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>{"\uCDE8\uC18C"}</button>
          <button
            className="btn btn-primary"
            disabled={!selectedPreset}
            onClick={() => selectedPreset && onSelect(selectedPreset)}
          >
            {"\uC120\uD0DD\uD55C \uD504\uB9AC\uC14B \uC801\uC6A9"}
          </button>
        </div>
      </div>
    </div>
  );
}
