import { useState } from 'react';

// PR3-B 계획서 §6.8.5 — 모든 그래프에 "데이터 보기" 표 전환을 둔다(색각·인쇄·강제
// 색상 모드의 1차 대안). table은 <thead>/<tbody>를 담은 JSX 조각이어야 한다.
export function DataTableView({ chart, table, tableCaption }) {
  const [showTable, setShowTable] = useState(false);
  return (
    <div className="chart-data-table-view">
      <div className="chart-toggle-row">
        <button
          type="button"
          className="chart-toggle-btn"
          aria-pressed={showTable}
          onClick={() => setShowTable((v) => !v)}
        >
          {showTable ? '그래프 보기' : '데이터 보기'}
        </button>
      </div>
      {showTable ? (
        <div className="swb-table-scroll">
          <table className="swb-table" aria-label={tableCaption}>{table}</table>
        </div>
      ) : chart}
    </div>
  );
}
