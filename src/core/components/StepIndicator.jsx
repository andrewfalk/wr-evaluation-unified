import { getModule } from '../moduleRegistry';

export function StepIndicator({ steps, currentStepIndex, goToStep }) {
  let lastGroup = null;
  return (
    <div className="wizard-steps-full">
      {steps.map((s, i) => {
        const showGroupLabel = s.group !== 'shared' && s.group !== lastGroup;
        lastGroup = s.group;
        const mod = s.moduleId ? getModule(s.moduleId) : null;
        return (
          <div key={s.id} className="contents-wrapper">
            {showGroupLabel && (
              <div className="wizard-group-label">{mod?.icon} {mod?.name}</div>
            )}
            <div
              className={`wizard-step-compact ${i === currentStepIndex ? 'active' : ''} ${i < currentStepIndex ? 'done' : ''}`}
              onClick={() => goToStep(i)}
            >
              <span className="wizard-step-num">{i < currentStepIndex ? '✓' : i + 1}</span>
              <span className="wizard-step-label">{s.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
