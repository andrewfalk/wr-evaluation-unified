import { useMemo, useState } from 'react';

const MODULE_LABELS = {
  knee: '무릎', spine: '척추', shoulder: '어깨',
  cervical: '경추', elbow: '팔꿈치', wrist: '손목',
};

function moduleLabel(id) {
  return MODULE_LABELS[id] || id;
}

// PR2 §5.6.1 — 카탈로그 검색 + 모듈 칩 필터 + 그룹별 변수 목록. 지금은 7개뿐이라 "218개를
// 그냥 펼치면 못 쓴다"는 문제가 아직 실감 나지 않지만, PR0-B3가 카탈로그를 확장할 걸
// 전제로 구조(검색·칩 필터·그룹핑)는 처음부터 갖춘다.
export function CatalogPanel({ catalog, selectedKeys, onToggleVariable, collapsed, onToggleCollapse }) {
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState('all');

  const variables = catalog?.variables ?? [];
  const modules = useMemo(
    () => Array.from(new Set(variables.map((v) => v.moduleId))).sort(),
    [variables],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return variables.filter((v) => {
      if (moduleFilter !== 'all' && v.moduleId !== moduleFilter) return false;
      if (!q) return true;
      return v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q);
    });
  }, [variables, moduleFilter, search]);

  const groups = useMemo(() => {
    const byGroup = new Map();
    for (const v of filtered) {
      if (!byGroup.has(v.group)) byGroup.set(v.group, []);
      byGroup.get(v.group).push(v);
    }
    return Array.from(byGroup.entries());
  }, [filtered]);

  if (collapsed) {
    return (
      <aside className="swb-panel swb-panel--collapsed" aria-label="변수 카탈로그(접힘)">
        <div className="swb-panel-header">
          <button
            type="button"
            className="swb-collapse-btn"
            onClick={onToggleCollapse}
            aria-expanded={false}
            title="카탈로그 펼치기"
          >›</button>
        </div>
        <div className="swb-panel-rail">카탈로그 · 선택 {selectedKeys.length}</div>
      </aside>
    );
  }

  return (
    <aside className="swb-panel swb-panel--catalog" aria-label="변수 카탈로그">
      <div className="swb-panel-header">
        <span>변수 카탈로그 · 선택 {selectedKeys.length}</span>
        <button
          type="button"
          className="swb-collapse-btn"
          onClick={onToggleCollapse}
          aria-expanded
          title="카탈로그 접기"
        >‹</button>
      </div>
      <div className="swb-panel-body">
        <input
          className="swb-search"
          type="text"
          placeholder="변수 검색"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="swb-chip-row">
          <button
            type="button"
            className={`swb-chip${moduleFilter === 'all' ? ' swb-chip--active' : ''}`}
            onClick={() => setModuleFilter('all')}
          >전체</button>
          {modules.map((m) => (
            <button
              key={m}
              type="button"
              className={`swb-chip${moduleFilter === m ? ' swb-chip--active' : ''}`}
              onClick={() => setModuleFilter(m)}
            >{moduleLabel(m)}</button>
          ))}
        </div>
        {groups.length === 0 && <div className="swb-empty">조건에 맞는 변수가 없습니다.</div>}
        {groups.map(([group, vars]) => (
          <div key={group}>
            <div className="swb-section-label">{group}</div>
            {vars.map((v) => (
              <label key={v.key} className="swb-var-row">
                <input
                  type="checkbox"
                  checked={selectedKeys.includes(v.key)}
                  onChange={() => onToggleVariable(v.key)}
                />
                <span className="swb-var-label">{v.label}</span>
                {v.unit && <span className="swb-var-badge">{v.unit}</span>}
                <span className="swb-var-badge">{v.type}</span>
                {v.sensitivity !== 'non_sensitive' && (
                  <span className="swb-var-badge swb-var-badge--sensitive">민감</span>
                )}
              </label>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}
