// 프리셋 저장 창 조각(P2-88c, Phase 2 C9 구간 A) — PresetManageModal.tsx에서 옮겼다. 프리셋 값 미리보기 — 예전 본체의 renderReadableFieldPreview를 컴포넌트로(그리는 JSX는 글자 그대로).
import { getModule } from '../../moduleRegistry';
import type { ModuleManifest, PresetFieldDef, PresetTaskListFieldDef } from '../../modules/manifest';
import { formatPresetFieldValue } from './presetSearch';

/** 척추 작업 카드(모듈이 칩을 주지 않을 때 그리는 값). */
interface PresetTask {
  name?: string;
  posture?: string;
  weight?: number | null;
  frequency?: number | null;
  timeValue?: number | string;
  timeUnit?: string;
  correctionFactor?: number | string;
}

interface PresetTaskListPreviewProps {
  taskListField: PresetTaskListFieldDef;
  tasks: PresetTask[];
  storedOnly: boolean;
}

/** 작업 목록형(taskList 필드 — spine·cervical) 미리보기: 작업 카드와 칩. */
export function PresetTaskListPreview({ taskListField, tasks, storedOnly }: PresetTaskListPreviewProps) {
  return (
    <div className="preset-field-preview">
      {storedOnly && (
        <div className="preset-preview-source">{"\uAE30\uC874 \uD504\uB9AC\uC14B\uC5D0 \uC800\uC7A5\uB41C \uAC12\uC744 \uADF8\uB300\uB85C \uC720\uC9C0 \uC911\uC785\uB2C8\uB2E4."}</div>
      )}
      {tasks.map((task, index) => (
        <div key={index} className="preset-task-card">
          <div className="preset-task-title">{task.name}</div>
          <div className="preset-task-meta">
            {/* \uCE69 \uBB38\uAD6C\uB294 \uBAA8\uB4C8\uC774 \uC8FC\uACE0(presetConfig taskList \uD544\uB4DC\uC758 chips \u2014 \uACBD\uCD94, FX-3), \uC5C6\uC73C\uBA74 \uCC99\uCD94 \uC791\uC5C5 \uCE69\uC744 \uADF8\uB9B0\uB2E4. */}
            {taskListField.chips ? taskListField.chips(task as Readonly<Record<string, unknown>>).map((chip, chipIndex) => (
              <span key={chipIndex} className="preset-task-chip">{chip}</span>
            )) : (
              <>
                {task.posture && <span className="preset-task-chip">{task.posture}</span>}
                {task.weight !== undefined && task.weight !== null && (
                  <span className="preset-task-chip">{`${task.weight}kg`}</span>
                )}
                {task.frequency !== undefined && task.frequency !== null && (
                  <span className="preset-task-chip">{`${task.frequency}\uD68C`}</span>
                )}
                {task.timeValue ? (
                  <span className="preset-task-chip">{`${task.timeValue}${task.timeUnit || ''}`}</span>
                ) : null}
                {task.correctionFactor ? (
                  <span className="preset-task-chip">{`\uBCF4\uC815 ${task.correctionFactor}`}</span>
                ) : null}
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

interface PresetValueFieldsPreviewProps {
  fields: PresetFieldDef[];
  data: Record<string, unknown>;
  storedOnly: boolean;
}

/** 필드형 미리보기: 값이 있는 필드만 라벨·표시값 줄로. */
export function PresetValueFieldsPreview({ fields, data, storedOnly }: PresetValueFieldsPreviewProps) {
  return (
    <div className="preset-field-preview">
      {storedOnly && (
        <div className="preset-preview-source">{"\uAE30\uC874 \uD504\uB9AC\uC14B\uC5D0 \uC800\uC7A5\uB41C \uAC12\uC744 \uADF8\uB300\uB85C \uC720\uC9C0 \uC911\uC785\uB2C8\uB2E4."}</div>
      )}
      {fields.map(field => {
        const value = data[field.key];
        if (value === undefined || value === '' || value === null) return null;
        const display = formatPresetFieldValue(value, field.type);
        return (
          <div key={field.key} className="preset-preview-row">
            <span className="preset-preview-label">{field.label}</span>
            <span className="preset-preview-value">{display}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface PresetFieldPreviewProps {
  moduleId: string;
  /** 모듈의 프리셋 값(지금 환자에서 뽑은 값 또는 저장된 값). */
  data: unknown;
  storedOnly?: boolean;
}

/** 모듈 하나의 프리셋 값 미리보기. 작업 목록형을 먼저 보고, 저장된 값에 그 목록이 없으면 아무것도 그리지 않는다. */
export function PresetFieldPreview({ moduleId, data: snapshot, storedOnly = false }: PresetFieldPreviewProps) {
  const mod: ModuleManifest | undefined = getModule(moduleId);
  const data = snapshot as Record<string, unknown> | null;
  if (!mod?.presetConfig || !data) return null;

  const { fields } = mod.presetConfig;

  // 작업 목록형(taskList 필드 — spine·cervical)을 먼저 본다. 저장된 값에 그 목록이 없으면 아무것도 그리지 않는다.
  const taskListField = fields.find(field => field.type === 'taskList') as PresetTaskListFieldDef | undefined;
  if (taskListField) {
    const tasks = data[taskListField.key] as PresetTask[] | undefined;
    if (!tasks) return null;
    return <PresetTaskListPreview taskListField={taskListField} tasks={tasks} storedOnly={storedOnly} />;
  }

  return <PresetValueFieldsPreview fields={fields} data={data} storedOnly={storedOnly} />;
}
