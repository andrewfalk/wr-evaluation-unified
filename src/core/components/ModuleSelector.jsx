import { getAllModules } from '../moduleRegistry';

export function ModuleSelector({ onSelect }) {
  const modules = getAllModules();

  return (
    <div className="module-selector">
      <div className="module-selector-header pattern-surface module-selector-hero">
        <div className="section-title-row">
          <h2>평가 유형 선택</h2>
          <p>평가할 신체 부위를 선택하면 해당 모듈의 입력 흐름으로 바로 이동합니다.</p>
        </div>
      </div>
      <div className="module-cards">
        {modules.map(mod => (
          <div
            key={mod.id}
            className="module-card pattern-surface"
            onClick={() => onSelect(mod.id)}
          >
            <div className="module-card-icon">{mod.icon}</div>
            <div className="module-card-body">
              <h3>{mod.name}</h3>
              <p>{mod.description}</p>
            </div>
            <span className="module-card-cta">평가 시작</span>
          </div>
        ))}
      </div>
    </div>
  );
}
