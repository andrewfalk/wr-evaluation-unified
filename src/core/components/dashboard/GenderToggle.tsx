// 대시보드 화면 조각(P2-85a, Phase 2 C9 구간 A) — Dashboard.tsx에서 선언 본문 그대로 옮겼다(바뀐 것은 export와 import뿐).
// 카드의 성별 토글(전체·남·여)과 토글을 가진 카드 — 카드마다 선택 상태를 따로 가진다.
import { useState } from 'react';
import type { ReactNode } from 'react';

export const GENDER_OPTIONS = [
  { key: 'all', label: '전체' },
  { key: 'male', label: '남' },
  { key: 'female', label: '여' },
];

export interface GenderToggleProps {
  value: string;
  onChange: (key: string) => void;
}

export const GenderToggle = ({ value, onChange }: GenderToggleProps) => (
  <div className="card-gender-toggle">
    {GENDER_OPTIONS.map(opt => (
      <button
        key={opt.key}
        type="button"
        className={`card-gender-btn${value === opt.key ? ' card-gender-btn--active' : ''}`}
        onClick={() => onChange(opt.key)}
      >
        {opt.label}
      </button>
    ))}
  </div>
);

export interface GenderToggleCardProps<T> {
  title: ReactNode;
  data: Record<string, T> | undefined;
  renderBody: (value: T | undefined, gender: string) => ReactNode;
}

export const GenderToggleCard = <T,>({ title, data, renderBody }: GenderToggleCardProps<T>) => {
  const [g, setG] = useState('all');
  return (
    <div className="dashboard-stat-card metric-card pattern-surface dashboard-card-with-toggle">
      <div className="card-toggle-row">
        <div className="stat-label">{title}</div>
        <GenderToggle value={g} onChange={setG} />
      </div>
      <div className="card-toggle-body">{renderBody(data?.[g], g)}</div>
    </div>
  );
};
