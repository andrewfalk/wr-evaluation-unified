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
  const [pendingSelectId, setPendingSelectId] = useState(null);

  // sharedJobId가 빈 태스크는 첫 번째 직업에 귀속(마이그레이션), 삭제된 직업을 가리키는 고아 태스크는 정리
  useEffect(() => {
    if (jobs.length === 0) return;
    const firstId = jobs[0].id;
    const jobIds = new Set(jobs.map(j => j.id).filter(Boolean));
    const tasks = mod.tasks || [];
    const hasEmpty = tasks.some(t => !t.sharedJobId);
    const hasOrphan = tasks.some(t => t.sharedJobId && !jobIds.has(t.sharedJobId));
    if (!hasEmpty && !hasOrphan) return;
    updateModule(m => ({
      ...m,
      tasks: (m.tasks || [])
        .filter(t => !t.sharedJobId || jobIds.has(t.sharedJobId))
        .map(t => t.sharedJobId ? t : { ...t, sharedJobId: firstId })
    }));
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const allTasks = useMemo(() => (mod.tasks || []).map(t => {
    const result = calculateCompressiveForce(t.posture, t.weight, t.correctionFactor);
    return { ...t, force: result ? result.force : 0 };
  }), [mod.tasks]);

  const firstJobId = jobs[0]?.id || '';
  // selectedJobId가 유효하지 않으면 firstJobId로 보정 (렌더용 임시값)
  const activeJobId = jobs.find(j => j.id === selectedJobId) ? selectedJobId : firstJobId;

  // 단일 진실원: TaskManager가 보여주는 task 목록 + 모든 핸들러(select/remove/reorder)의 기준
  const visibleTasks = useMemo(() => {
    if (jobs.length === 0) return allTasks;
    return allTasks.filter(t => (t.sharedJobId || firstJobId) === activeJobId);
  }, [jobs.length, allTasks, firstJobId, activeJobId]);

  // 선택된 task의 전체 배열 내 실제 index (visibleTasks 기준)
  const globalIndex = useMemo(() => {
    if (selectedTaskIndex < 0 || selectedTaskIndex >= visibleTasks.length) return -1;
    const task = visibleTasks[selectedTaskIndex];
    return allTasks.findIndex(t => t.id === task.id);
  }, [visibleTasks, selectedTaskIndex, allTasks]);

  const selectedTask = globalIndex >= 0 ? allTasks[globalIndex] : null;

  // 직업 탭 변경 시 task 선택 리셋
  const handleJobChange = useCallback((jobId) => {
    setSelectedJobId(jobId);
    setSelectedTaskIndex(0);
  }, []);

  const handleAddTask = useCallback(() => {
    const jobId = activeJobId;
    const existingCount = visibleTasks.length;
    const newTask = createTask(existingCount, jobId);
    const result = calculateCompressiveForce(newTask.posture, newTask.weight, newTask.correctionFactor);
    newTask.force = result ? result.force : 0;
    updateModule(m => ({
      ...m,
      tasks: [...(m.tasks || []), newTask]
    }));
    // 새 task는 visibleTasks의 마지막에 추가됨 → 그 인덱스로 선택 이동
    setSelectedTaskIndex(existingCount);
  }, [visibleTasks, activeJobId, updateModule]);

  const handleRemoveTask = useCallback((visibleIndex) => {
    const task = visibleTasks[visibleIndex];
    if (!task) return;
    const gIdx = allTasks.findIndex(t => t.id === task.id);
    if (gIdx < 0) return;
    updateModule(m => {
      const newTasks = (m.tasks || []).filter((_, i) => i !== gIdx);
      return { ...m, tasks: newTasks };
    });
    setSelectedTaskIndex(prev => {
      if (prev >= visibleTasks.length - 1) return Math.max(0, visibleTasks.length - 2);
      if (prev > visibleIndex) return prev - 1;
      return prev;
    });
  }, [visibleTasks, allTasks, updateModule]);

  const handleTaskUpdate = useCallback((updatedTask) => {
    if (globalIndex < 0) return;
    updateModule(m => {
      const newTasks = [...(m.tasks || [])];
      newTasks[globalIndex] = updatedTask;
      return { ...m, tasks: newTasks };
    });
  }, [globalIndex, updateModule]);

  // 드래그앤드롭 reorder — visible 범위 내에서만, id 기반 재구성
  const handleReorderTask = useCallback((fromIdx, toIdx) => {
    if (fromIdx === toIdx) return;
    const fromTask = visibleTasks[fromIdx];
    const toTask = visibleTasks[toIdx];
    if (!fromTask || !toTask) return;
    const fromId = fromTask.id;
    const toId = toTask.id;
    const visibleIds = visibleTasks.map(t => t.id);
    const visibleIdSet = new Set(visibleIds);

    updateModule(m => {
      const all = m.tasks || [];
      const byId = new Map(all.map(t => [t.id, t]));
      const visibleSubset = visibleIds.map(id => byId.get(id)).filter(Boolean);

      const fromSubIdx = visibleSubset.findIndex(t => t.id === fromId);
      const toSubIdx = visibleSubset.findIndex(t => t.id === toId);
      if (fromSubIdx < 0 || toSubIdx < 0) return m;
      const [moved] = visibleSubset.splice(fromSubIdx, 1);
      visibleSubset.splice(toSubIdx, 0, moved);

      // mod.tasks 재구성: visibleIdSet 위치는 새 순서로 채우고 그 외 task는 그대로
      let visIter = 0;
      const next = all.map(t => {
        if (visibleIdSet.has(t.id)) return visibleSubset[visIter++];
        return t;
      });
      return { ...m, tasks: next };
    });

    setPendingSelectId(fromId);
  }, [visibleTasks, updateModule]);

  // visibleTasks가 갱신되면 pendingSelectId가 가리키는 task의 새 위치로 선택 보정
  useEffect(() => {
    if (!pendingSelectId) return;
    const idx = visibleTasks.findIndex(t => t.id === pendingSelectId);
    if (idx >= 0) setSelectedTaskIndex(idx);
    setPendingSelectId(null);
  }, [visibleTasks, pendingSelectId]);

  return (
    <>
      <div className="panel">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">&#x1F9CD;</span>요추 작업 평가</h2>
            <p className="section-description">직업별 허리 부담 작업을 나눠 입력하고, 선택한 작업의 자세와 하중 조건을 편집합니다.</p>
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
            tasks={visibleTasks}
            selectedIndex={selectedTaskIndex}
            onSelect={setSelectedTaskIndex}
            onAdd={handleAddTask}
            onRemove={handleRemoveTask}
            onReorder={handleReorderTask}
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
