import { useState, useCallback, useMemo, useEffect } from 'react';
import { TaskManager } from './components/TaskManager';
import { TaskEditor } from './components/TaskEditor';
import { SpineResultPanel } from './components/SpineResultPanel';
import { calculateCompressiveForce } from './utils/calculations';
import { createTask } from './utils/data';
import { getEffectiveWorkPeriodText } from '../../core/utils/workPeriod';

export function SpineEvaluation({ patient, calc, activeTab, updateModule, errors }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const jobs = shared.jobs || [];
  const [selectedJobId, setSelectedJobId] = useState(jobs[0]?.id || '');
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);

  // 기존 태스크 중 sharedJobId가 빈 것을 첫 번째 직업에 귀속 (마이그레이션)
  useEffect(() => {
    const fj = jobs[0]?.id;
    if (fj && (mod.tasks || []).some(t => !t.sharedJobId)) {
      updateModule(m => ({
        ...m,
        tasks: (m.tasks || []).map(t => t.sharedJobId ? t : { ...t, sharedJobId: fj })
      }));
    }
  }, [jobs[0]?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const allTasks = useMemo(() => (mod.tasks || []).map(t => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  }), [mod.tasks]);

  // 선택된 직업의 task만 필터 (sharedJobId 없으면 첫 번째 job 귀속)
  const firstJobId = jobs[0]?.id || '';
  const filteredTasks = useMemo(() => {
    if (jobs.length === 0) return allTasks;
    return allTasks.filter(t => (t.sharedJobId || firstJobId) === selectedJobId);
  }, [allTasks, selectedJobId, firstJobId, jobs.length]);

  // 선택된 task의 전체 배열 내 실제 index
  const globalIndex = useMemo(() => {
    if (selectedTaskIndex < 0 || selectedTaskIndex >= filteredTasks.length) return -1;
    const task = filteredTasks[selectedTaskIndex];
    return allTasks.findIndex(t => t.id === task.id);
  }, [filteredTasks, selectedTaskIndex, allTasks]);

  const selectedTask = globalIndex >= 0 ? allTasks[globalIndex] : null;

  // 직업 탭 변경 시 task 선택 리셋
  const handleJobChange = useCallback((jobId) => {
    setSelectedJobId(jobId);
    setSelectedTaskIndex(0);
  }, []);

  const handleAddTask = useCallback(() => {
    const jobId = selectedJobId || firstJobId;
    const existingCount = (mod.tasks || []).filter(t => (t.sharedJobId || firstJobId) === jobId).length;
    const newTask = createTask(existingCount, jobId);
    const result = calculateCompressiveForce(newTask.posture, newTask.weight, newTask.correctionFactor);
    newTask.force = result ? result.force : 0;
    updateModule(m => ({
      ...m,
      tasks: [...(m.tasks || []), newTask]
    }));
    // 새 task는 필터된 목록의 마지막에 추가됨
    const newFilteredCount = (mod.tasks || []).filter(t => (t.sharedJobId || firstJobId) === jobId).length;
    setSelectedTaskIndex(newFilteredCount);
  }, [mod.tasks, updateModule, selectedJobId, firstJobId]);

  const handleRemoveTask = useCallback((filteredIndex) => {
    const task = filteredTasks[filteredIndex];
    if (!task) return;
    const gIdx = allTasks.findIndex(t => t.id === task.id);
    if (gIdx < 0) return;
    updateModule(m => {
      const newTasks = (m.tasks || []).filter((_, i) => i !== gIdx);
      return { ...m, tasks: newTasks };
    });
    setSelectedTaskIndex(prev => {
      if (prev >= filteredTasks.length - 1) return Math.max(0, filteredTasks.length - 2);
      if (prev > filteredIndex) return prev - 1;
      return prev;
    });
  }, [filteredTasks, allTasks, updateModule]);

  const handleTaskUpdate = useCallback((updatedTask) => {
    if (globalIndex < 0) return;
    updateModule(m => {
      const newTasks = [...(m.tasks || [])];
      newTasks[globalIndex] = updatedTask;
      return { ...m, tasks: newTasks };
    });
  }, [globalIndex, updateModule]);

  // selectedJobId가 유효하지 않으면 보정
  if (jobs.length > 0 && !jobs.find(j => j.id === selectedJobId)) {
    // 렌더 중 setState 불가 → useEffect에서 처리하거나, 그냥 firstJobId로 렌더
    // 여기서는 렌더 시 임시로 firstJobId 사용
  }
  const activeJobId = jobs.find(j => j.id === selectedJobId) ? selectedJobId : firstJobId;

  return (
    <>
      <div className="panel">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">&#x1F9CD;</span>척추 작업 평가</h2>
            <p className="section-description">직업별 작업을 나눠 입력하고, 선택한 작업의 자세와 하중 조건을 편집합니다.</p>
          </div>
        </div>

        {jobs.length > 1 && (
          <div className="action-group" style={{ marginBottom: 12 }}>
            {jobs.map((job, i) => {
              const isActive = activeJobId === job.id;
              const jobTaskCount = allTasks.filter(t => (t.sharedJobId || firstJobId) === job.id).length;
              return (
                <button
                  key={job.id}
                  className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleJobChange(job.id)}
                >
                  직력{i + 1}: {job.jobName || '(미입력)'} ({getEffectiveWorkPeriodText(job)})
                  <span style={{ marginLeft: 4, opacity: 0.7 }}>[{jobTaskCount}]</span>
                </button>
              );
            })}
          </div>
        )}

        {jobs.length === 0 && (
          <div className="evaluation-empty-state" style={{ marginBottom: 12 }}>
            직업력을 먼저 등록하세요 (기본정보 → 직업력)
          </div>
        )}

        <div className="evaluation-stack">
          <TaskManager
            tasks={jobs.length === 0 ? allTasks : filteredTasks.length > 0 ? filteredTasks : allTasks.filter(t => (t.sharedJobId || firstJobId) === activeJobId)}
            selectedIndex={selectedTaskIndex}
            onSelect={setSelectedTaskIndex}
            onAdd={handleAddTask}
            onRemove={handleRemoveTask}
          />
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
