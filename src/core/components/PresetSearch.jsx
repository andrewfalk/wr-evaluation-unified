import { useState, useEffect, useRef } from 'react';

export function PresetSearch({ presets, onSelect, value, onChange }) {
  const [query, setQuery] = useState(value || '');
  const [showResults, setShowResults] = useState(false);
  const [results, setResults] = useState([]);
  const ref = useRef();

  useEffect(() => { setQuery(value || ''); }, [value]);

  useEffect(() => {
    const handleClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setShowResults(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const handleSearch = (q) => {
    setQuery(q);
    onChange(q);
    if (q.length >= 1) {
      const filtered = presets
        .filter(p => p.jobName.toLowerCase().includes(q.toLowerCase()) || p.category.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 8);
      setResults(filtered);
      setShowResults(filtered.length > 0);
    } else {
      setShowResults(false);
    }
  };

  return (
    <div className="search-container" ref={ref}>
      <input value={query} onChange={e => handleSearch(e.target.value)} onFocus={() => query && results.length && setShowResults(true)} placeholder="직종명 검색..." />
      {showResults && (
        <div className="search-results">
          {results.map(p => (
            <div key={p.id} className="search-item" onClick={() => { setQuery(p.jobName); setShowResults(false); onSelect(p); }}>
              <div className="search-item-name">{p.jobName}</div>
              <div className="search-item-info">{p.category} | {p.weight}kg | {p.squatting}분</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
