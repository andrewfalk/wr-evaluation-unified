import { useState, useCallback } from 'react';
import { TaskManager } from './components/TaskManager';
import { TaskEditor } from './components/TaskEditor';
import { SpineResultPanel } from './components/SpineResultPanel';
import { calculateCompressiveForce } from './utils/calculations';

export function SpineEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);

  const tasks = (mod.tasks || []).map(t => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  });

  const selectedTask = selectedTaskIndex >= 0 && selectedTaskIndex < tasks.length ? tasks[selectedTaskIndex] : null;

  const handleAddTask = useCallback((newTask) => {
    const result = calculateCompressiveForce(newTask.posture, newTask.weight, newTask.correctionFactor);
    newTask.force = result ? result.force : 0;
    updateModule(m => ({
      ...m,
      tasks: [...(m.tasks || []), newTask]
    }));
    setSelectedTaskIndex((mod.tasks || []).length);
  }, [mod.tasks, updateModule]);

  const handleRemoveTask = useCallback((index) => {
    updateModule(m => {
      const newTasks = (m.tasks || []).filter((_, i) => i !== index);
      return { ...m, tasks: newTasks };
    });
    setSelectedTaskIndex(prev => {
      if (prev >= (mod.tasks || []).length - 1) return Math.max(0, (mod.tasks || []).length - 2);
      if (prev > index) return prev - 1;
      return prev;
    });
  }, [mod.tasks, updateModule]);

  const handleTaskUpdate = useCallback((updatedTask) => {
    updateModule(m => {
      const newTasks = [...(m.tasks || [])];
      newTasks[selectedTaskIndex] = updatedTask;
      return { ...m, tasks: newTasks };
    });
  }, [selectedTaskIndex, updateModule]);

  return (
    <>
      <div className="panel">
        <TaskManager
          tasks={tasks}
          selectedIndex={selectedTaskIndex}
          onSelect={setSelectedTaskIndex}
          onAdd={handleAddTask}
          onRemove={handleRemoveTask}
        />
        <div style={{ marginTop: 15, borderTop: '2px solid var(--card-border)', paddingTop: 15 }}>
          <TaskEditor
            task={selectedTask}
            gender={shared.gender || 'male'}
            onChange={handleTaskUpdate}
          />
        </div>
      </div>
      <SpineResultPanel calc={calc} />
    </>
  );
}
