// 대시보드 화면 조각(P2-85a, Phase 2 C9 구간 A) — Dashboard.tsx에서 선언 본문 그대로 옮겼다(바뀐 것은 export와 import뿐).
// Top 5 목록 — 컴포넌트가 아니라 함수로 부른다(`Top5List(items)`, 지금 그대로).
export interface Top5Item {
  key: string;
  name?: string;
  count: number;
}

export const Top5List = (items: Top5Item[] | null | undefined) => {
  const filled: Array<Top5Item | null> = [...(items || [])];
  while (filled.length < 5) filled.push(null);
  return (
    <div className="stat-job-grid">
      {filled.map((it, i) => (
        <div className="stat-job-row" key={i}>
          {it ? (
            <>
              <div className="stat-job-name" title={it.name || ''}>
                {it.key}{it.name ? ` · ${it.name}` : ''}
              </div>
              <div className="stat-job-count">{it.count}명</div>
            </>
          ) : (
            <>
              <div className="stat-job-name stat-empty-row">&nbsp;</div>
              <div className="stat-job-count">&nbsp;</div>
            </>
          )}
        </div>
      ))}
    </div>
  );
};
