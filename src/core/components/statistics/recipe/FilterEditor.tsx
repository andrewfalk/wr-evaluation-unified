// 필터 편집기(변수·연산자·값 입력 → 필터 추가) — P2-79b에서 RecipePanel.tsx의 선언을 본문 그대로 옮겼다.
// 내부 상태(key·operator·raw·error)를 비우려고 부모가 key로 다시 마운트한다(RecipePanel의 <FilterEditor key>).
import { useState } from 'react';
import { TYPE_ALLOWED_OPERATORS, OPERATOR_LABELS } from './labels';
import type { CatalogVariable, StatsFilter, StatsFilterOperator } from '@wr/contracts/stats';
import type { FilterRaw, CatalogByKey } from './types';
import { needsValue, inputTypeFor, emptyRawValueFor, buildFilterValue } from './filterValues';

function FilterValueInput({ variable, operator, raw, onChange }: {
  variable: CatalogVariable; operator: string; raw: FilterRaw; onChange: (raw: FilterRaw) => void;
}) {
  if (!needsValue(operator)) return null;

  if (variable.type === 'boolean') {
    return (
      <select className="swb-search" value={raw || ''} onChange={(e) => onChange(e.target.value)}>
        <option value="">값 선택</option>
        <option value="true">참</option>
        <option value="false">거짓</option>
      </select>
    );
  }

  if (operator === 'between') {
    const [lower, upper] = Array.isArray(raw) ? raw : ['', ''];
    return (
      <span style={{ display: 'inline-flex', gap: 4, width: '100%' }}>
        <input
          className="swb-search"
          type={inputTypeFor(variable.type)}
          placeholder="하한"
          value={lower}
          onChange={(e) => onChange([e.target.value, upper])}
        />
        <input
          className="swb-search"
          type={inputTypeFor(variable.type)}
          placeholder="상한"
          value={upper}
          onChange={(e) => onChange([lower, e.target.value])}
        />
      </span>
    );
  }

  if (operator === 'in') {
    return (
      <input
        className="swb-search"
        type="text"
        placeholder="값1, 값2, ... (쉼표로 구분)"
        value={raw || ''}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  return (
    <input
      className="swb-search"
      type={inputTypeFor(variable.type)}
      placeholder="값"
      value={raw ?? ''}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

export function FilterEditor({ catalogByKey, onAdd }: { catalogByKey: CatalogByKey; onAdd: (filter: StatsFilter) => void }) {
  const keys = Array.from(catalogByKey.keys());
  const [pickedKey, setKey] = useState(keys[0] || '');
  // 후보 목록이 바뀌어(카탈로그 재조회·모드 전환) 고른 키가 사라지면 첫 후보로 대체한다 —
  // 그대로 두면 variable이 undefined가 되어 FilterValueInput이 렌더 중 예외를 던진다.
  const key = catalogByKey.has(pickedKey) ? pickedKey : (keys[0] || '');
  const [operator, setOperator] = useState<StatsFilterOperator>('eq');
  const [raw, setRaw] = useState<FilterRaw>('');
  const [error, setError] = useState<string | null | undefined>(null);
  const variable = catalogByKey.get(key);
  const allowedOps = variable ? (TYPE_ALLOWED_OPERATORS[variable.type] || []) : [];

  if (keys.length === 0) return null;

  return (
    <div className="swb-card swb-card--muted">
      <select
        className="swb-search"
        value={key}
        onChange={(e) => { setKey(e.target.value); setOperator('eq'); setRaw(''); setError(null); }}
      >
        {keys.map((k) => <option key={k} value={k}>{(catalogByKey.get(k) as CatalogVariable).label}</option>)}
      </select>
      <select
        className="swb-search"
        value={operator}
        onChange={(e) => { setOperator(e.target.value as StatsFilterOperator); setRaw(emptyRawValueFor(e.target.value)); setError(null); }}
      >
        {allowedOps.map((op) => <option key={op} value={op}>{OPERATOR_LABELS[op] || op}</option>)}
      </select>
      <FilterValueInput variable={variable as CatalogVariable} operator={operator} raw={raw} onChange={(v) => { setRaw(v); setError(null); }} />
      {error && <p className="swb-status-danger" style={{ margin: '4px 0' }}>{error}</p>}
      <button
        type="button"
        className="swb-btn swb-btn--sm"
        onClick={() => {
          if (!key || !operator || !variable) return;
          const result = buildFilterValue(variable, operator, raw);
          if (!result.ok) { setError(result.error); return; }
          onAdd({ key, operator, ...(result.value !== undefined ? { value: result.value } : {}) });
          setRaw(emptyRawValueFor(operator));
          setError(null);
        }}
      >필터 추가</button>
    </div>
  );
}
