import { useCallback, useEffect, useMemo, useState } from 'react';
import { getEffectiveWorkPeriodText } from '../../core/utils/workPeriod';
import { TaskManager } from './components/TaskManager';
import { TaskEditor } from './components/TaskEditor';
import { CervicalResultPanel } from './components/CervicalResultPanel';
import { createCervicalTask, isCervicalDiagnosis, syncCervicalModuleData } from './utils/data';

export function CervicalEvaluation({ patient, calc, updateModule }) {
  const shared = patient.data.shared || {};
  const mod = patient.data.module || {};
  const diagnoses = shared.diagnoses || [];
  const sharedJobs = shared.jobs || [];
  const cervicalDiagnoses = useMemo(
    () => (diagnoses || []).filter(isCervicalDiagnosis),
    [diagnoses]
  );
  const [selectedJobId, setSelectedJobId] = useState(sharedJobs[0]?.id || '');
  const [selectedTaskIndex, setSelectedTaskIndex] = useState(0);

  const synced = useMemo(() => syncCervicalModuleData(mod, sharedJobs), [mod, sharedJobs]);

  useEffect(() => {
    if (synced.changed) {
      updateModule(() => synced.moduleData);
    }
  }, [synced, updateModule]);

  useEffect(() => {
    if (!sharedJobs.find(job => job.id === selectedJobId)) {
      setSelectedJobId(sharedJobs[0]?.id || '');
      setSelectedTaskIndex(0);
    }
  }, [sharedJobs, selectedJobId]);

  if (cervicalDiagnoses.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          경추(목)로 분류되는 상병이 없습니다. 진단명 또는 코드에 맞는 경추 상병을 입력하면 이 모듈을 사용할 수 있습니다.
        </div>
      </div>
    );
  }

  if (sharedJobs.length === 0) {
    return (
      <div className="panel">
        <div className="evaluation-empty-state">
          기본정보에서 직업력을 먼저 입력해 주세요. 경추 모듈은 직업별 작업 목록 구조를 사용합니다.
        </div>
      </div>
    );
  }

  const allTasks = synced.moduleData.tasks || [];
  const activeJobId = sharedJobs.find(job => job.id === selectedJobId) ? selectedJobId : (sharedJobs[0]?.id || '');
  const filteredTasks = allTasks.filter(task => task.sharedJobId === activeJobId);
  const selectedTask = filteredTasks[selectedTaskIndex] || null;

  const handleJobChange = useCallback((jobId) => {
    setSelectedJobId(jobId);
    setSelectedTaskIndex(0);
  }, []);

  const handleAddTask = useCallback(() => {
    const jobId = activeJobId || sharedJobs[0]?.id || '';
    if (!jobId) return;

    updateModule(current => {
      const normalized = syncCervicalModuleData(current, sharedJobs).moduleData;
      const jobTaskCount = (normalized.tasks || []).filter(task => task.sharedJobId === jobId).length;
      return {
        ...normalized,
        tasks: [...(normalized.tasks || []), createCervicalTask(jobTaskCount, jobId)],
      };
    });

    setSelectedTaskIndex(filteredTasks.length);
  }, [activeJobId, filteredTasks.length, sharedJobs, updateModule]);

  const handleRemoveTask = useCallback((taskId) => {
    updateModule(current => {
      const normalized = syncCervicalModuleData(current, sharedJobs).moduleData;
      return {
        ...normalized,
        tasks: (normalized.tasks || []).filter(task => task.id !== taskId),
      };
    });

    setSelectedTaskIndex(prev => {
      if (prev >= filteredTasks.length - 1) return Math.max(0, filteredTasks.length - 2);
      return prev;
    });
  }, [filteredTasks.length, sharedJobs, updateModule]);

  const handleTaskUpdate = useCallback((updatedTask) => {
    updateModule(current => {
      const normalized = syncCervicalModuleData(current, sharedJobs).moduleData;
      return {
        ...normalized,
        tasks: (normalized.tasks || []).map(task => (
          task.id === updatedTask.id ? updatedTask : task
        )),
      };
    });
  }, [sharedJobs, updateModule]);

  return (
    <>
      <div className="panel">
        <div className="section-header">
          <div className="section-title-row">
            <h2 className="section-title"><span className="section-icon">&#x1F9E0;</span>직업별 경추 작업 평가</h2>
            <p className="section-description">직업별 경추 부담 작업을 여러 개 입력하고, 작업별 시간을 합산해 평가합니다.</p>
          </div>
        </div>

        {sharedJobs.length > 1 && (
          <div className="action-group" style={{ marginBottom: 12 }}>
            {sharedJobs.map((job, index) => {
              const isActive = activeJobId === job.id;
              const jobTaskCount = allTasks.filter(task => task.sharedJobId === job.id).length;
              return (
                <button
                  key={job.id}
                  type="button"
                  className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => handleJobChange(job.id)}
                >
                  직력{index + 1}: {job.jobName || '(미입력)'} ({getEffectiveWorkPeriodText(job)})
                  <span style={{ marginLeft: 4, opacity: 0.7 }}>[{jobTaskCount}]</span>
                </button>
              );
            })}
          </div>
        )}

        <div className="evaluation-stack">
          <TaskManager
            tasks={filteredTasks}
            selectedIndex={selectedTaskIndex}
            onSelect={setSelectedTaskIndex}
            onAdd={handleAddTask}
            onRemove={handleRemoveTask}
          />
          <TaskEditor
            task={selectedTask}
            onChange={handleTaskUpdate}
          />
        </div>
      </div>

      <CervicalResultPanel calc={calc} />
    </>
  );
}
