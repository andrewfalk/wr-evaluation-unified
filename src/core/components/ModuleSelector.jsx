import { getAllModules } from '../moduleRegistry';

export function ModuleSelector({ onSelect }) {
  const modules = getAllModules();

  return (
    <div className="module-selector">
      <div className="module-selector-header">
        <h2>평가 유형 선택</h2>
        <p>평가할 신체 부위를 선택하세요</p>
      </div>
      <div className="module-cards">
        {modules.map(mod => (
          <div
            key={mod.id}
            className="module-card"
            onClick={() => onSelect(mod.id)}
          >
            <div className="module-card-icon">{mod.icon}</div>
            <h3>{mod.name}</h3>
            <p>{mod.description}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
