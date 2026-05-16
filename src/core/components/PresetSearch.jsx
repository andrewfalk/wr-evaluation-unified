import { useEffect, useId, useRef, useState } from 'react';
import { getPresetCategory, getPresetDescription } from '../services/presetRepository';

const MODULE_LABELS = {
  knee: '무릎',
  shoulder: '어깨',
  spine: '요추(허리)',
  cervical: '경추(목)',
  elbow: '팔꿈치',
  wrist: '손목',
};

function ModuleBadges({ modules }) {
  if (!modules) return null;
  const ids = Object.keys(modules);
  if (!ids.length) return null;

  return (
    <span className="preset-module-badges">
      {ids.map(id => (
        <span key={id} className="preset-badge">{MODULE_LABELS[id] || id}</span>
      ))}
    </span>
  );
}

export function PresetSearch({ presets, onSelect, value, onChange }) {
  const [query, setQuery] = useState(value || '');
  const [showResults, setShowResults] = useState(false);
  const [results, setResults] = useState([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const ref = useRef(null);
  const itemRefs = useRef([]);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  useEffect(() => {
    setQuery(value || '');
  }, [value]);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        setShowResults(false);
        setActiveIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!showResults || activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, showResults]);

  const selectPreset = (preset) => {
    setQuery(preset.jobName);
    setShowResults(false);
    setActiveIndex(-1);
    onSelect(preset);
  };

  const handleSearch = (nextQuery) => {
    setQuery(nextQuery);
    onChange(nextQuery);
    setActiveIndex(-1);

    if (nextQuery.length < 1) {
      setResults([]);
      setShowResults(false);
      return;
    }

    const keyword = nextQuery.toLowerCase();
    const filtered = presets
      .filter(preset => (
        preset.jobName.toLowerCase().includes(keyword)
        || getPresetCategory(preset).toLowerCase().includes(keyword)
        || getPresetDescription(preset).toLowerCase().includes(keyword)
      ))
      .slice(0, 10);

    setResults(filtered);
    setShowResults(filtered.length > 0);
  };

  const handleKeyDown = (e) => {
    if (results.length === 0) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setShowResults(true);
      setActiveIndex(prev => (prev < 0 ? 0 : Math.min(prev + 1, results.length - 1)));
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setShowResults(true);
      setActiveIndex(prev => (prev < 0 ? results.length - 1 : Math.max(prev - 1, 0)));
      return;
    }

    if (e.key === 'Enter' && showResults && activeIndex >= 0) {
      e.preventDefault();
      selectPreset(results[activeIndex]);
      return;
    }

    if (e.key === 'Escape' && showResults) {
      e.preventDefault();
      setShowResults(false);
      setActiveIndex(-1);
    }
  };

  return (
    <div className="search-container preset-search" ref={ref}>
      <input
        className="preset-search-input"
        value={query}
        onChange={e => handleSearch(e.target.value)}
        onFocus={() => {
          if (query && results.length) setShowResults(true);
          setActiveIndex(-1);
        }}
        onKeyDown={handleKeyDown}
        placeholder="직종명 검색..."
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showResults}
        aria-controls={listboxId}
        aria-activedescendant={showResults && activeIndex >= 0 ? `${baseId}-option-${activeIndex}` : undefined}
      />
      {showResults && (
        <div className="search-results" id={listboxId} role="listbox">
          {results.map((preset, index) => (
            <div
              key={preset.id}
              id={`${baseId}-option-${index}`}
              ref={el => {
                itemRefs.current[index] = el;
              }}
              className={`search-item preset-search-item ${activeIndex === index ? 'is-active' : ''} ${preset.source === 'custom' || preset._customId ? 'is-custom' : ''}`}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectPreset(preset)}
              role="option"
              aria-selected={activeIndex === index}
            >
              <div className="search-item-name">
                {preset.jobName}
                {(preset.source === 'custom' || preset._customId) && (
                  <span className="preset-custom-tag">{"\uB0B4 \uD504\uB9AC\uC14B"}</span>
                )}
              </div>
              <div className="search-item-info">
                {getPresetCategory(preset)}
                <ModuleBadges modules={preset.modules} />
              </div>
              {!!getPresetDescription(preset) && (
                <div className="search-item-info">{getPresetDescription(preset)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
