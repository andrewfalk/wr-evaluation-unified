import { useEffect, useId, useRef, useState } from 'react';
import { getModule } from '../moduleRegistry';

const MODULE_LABELS = { knee: '무릎', shoulder: '어깨', spine: '척추', elbow: '팔꿈치' };

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

    const filtered = presets
      .filter(p => (
        p.jobName.toLowerCase().includes(nextQuery.toLowerCase()) ||
        p.category.toLowerCase().includes(nextQuery.toLowerCase())
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
                {(preset.source === 'custom' || preset._customId) && <span className="preset-custom-tag">custom</span>}
              </div>
              <div className="search-item-info">
                {preset.category}
                <ModuleBadges modules={preset.modules} />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
