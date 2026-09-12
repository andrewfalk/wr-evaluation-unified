import { useEffect, useMemo, useState } from 'react';

const MODULE_LABELS = {
  knee: '무릎', spine: '척추', shoulder: '어깨',
  cervical: '경추', elbow: '팔꿈치', wrist: '손목',
  // PR0-B3 Part C — job/diagnosis는 실제 UI 모듈이 아니라 shared.jobs[]/shared.diagnoses[]를
  // 가리키는 pseudo-moduleId다. 디자인 §5.6.1이 예고한 "공통" 성격의 모듈 칩과 같은 자리.
  job: '직업력(공통)',
  diagnosis: '신청상병(공통)',
  // Part C — 담당의·등록일(SnapshotRow 컬럼, statsSnapshotColumnVariables.ts)의 moduleId.
  meta: '사례 메타(공통)',
};

function moduleLabel(id) {
  return MODULE_LABELS[id] || id;
}

// PR2 §5.6.1 — 카탈로그 검색 + 모듈 칩 필터 + 그룹별 변수 목록. 지금은 7개뿐이라 "218개를
// 그냥 펼치면 못 쓴다"는 문제가 아직 실감 나지 않지만, PR0-B3가 카탈로그를 확장할 걸
// 전제로 구조(검색·칩 필터·그룹핑)는 처음부터 갖춘다.
// PR0-B3 Part A — grain prop 추가. 분석 변수 후보는 항상 "현재 grain"으로 한 번 더
// 거른다 — grain을 바꾼 뒤 사용자가 여전히 다른 grain의 변수를 볼 수 있으면 안 된다
// (계획 pr0-b3-shimmying-magpie.md "Grain 선택 UI" 절 — 후보 제한과 상태 초기화는 별개다).
export function CatalogPanel({ catalog, grain, selectedKeys, onToggleVariable, collapsed, onToggleCollapse }) {
  const [search, setSearch] = useState('');
  const [moduleFilter, setModuleFilter] = useState('all');

  // grain이 바뀌면 이전 grain에만 있던 모듈 칩 선택이 새 grain에서 "조건에 맞는 변수가
  // 없습니다"로 조용히 텅 비게 만들 수 있다 — 검색/모듈 필터를 함께 초기화한다.
  useEffect(() => {
    setModuleFilter('all');
    setSearch('');
  }, [grain]);

  const variables = catalog?.variables ?? [];
  // PR0-B3 Part C — 필터 전용 변수(예: 등록일)는 분석 변수 후보에서 뺀다. 필터로는 여전히
  // 선택 가능하다(RecipePanel.jsx의 FilterEditor는 grain만 거르고 analysisRole은 안 봄).
  const grainVariables = useMemo(
    () => variables.filter((v) => v.grain === grain && v.analysisRole !== 'filter_only'),
    [variables, grain],
  );
  const modules = useMemo(
    () => Array.from(new Set(grainVariables.map((v) => v.moduleId))).sort(),
    [grainVariables],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return grainVariables.filter((v) => {
      if (moduleFilter !== 'all' && v.moduleId !== moduleFilter) return false;
      if (!q) return true;
      return v.label.toLowerCase().includes(q) || v.key.toLowerCase().includes(q);
    });
  }, [grainVariables, moduleFilter, search]);

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
