import { useState, useCallback, useMemo, useEffect } from 'react';
import { VibrationIntervalManager } from './components/VibrationIntervalManager';
import { VibrationIntervalEditor } from './components/VibrationIntervalEditor';
import { createVibrationInterval } from './utils/data';
import { resolveVibrationStatus } from './utils/vibrationCalc';
import { getEffectiveWorkPeriodText } from '../../core/utils/workPeriod';

const WBV_STATUS_OPTIONS = [
  { value: 'unknown', label: '미평가' },
  { value: 'none', label: '노출없음' },
  { value: 'present', label: '노출있음' },
];

export function VibrationEvaluation({ patient, updateModule, methodTabs }) {
  const shared = patient.data.shared;
  const mod = patient.data.module;
  const jobs = shared.jobs || [];
  const status = resolveVibrationStatus(mod);
  const [selectedJobId, setSelectedJobId] = useState(jobs[0]?.id || '');
  const [selectedIndex, setSelectedIndex] = useState(0);

  // sharedJobId가 빈 구간은 첫 직업에 귀속, 삭제된 직업을 가리키는 고아 구간은 정리.
  useEffect(() => {
    if (jobs.length === 0) return;
    const firstId = jobs[0].id;
    const jobIds = new Set(jobs.map(j => j.id).filter(Boolean));
    const intervals = mod.vibrationIntervals || [];
    const hasEmpty = intervals.some(iv => !iv.sharedJobId);
    const hasOrphan = intervals.some(iv => iv.sharedJobId && !jobIds.has(iv.sharedJobId));
    if (!hasEmpty && !hasOrphan) return;
    updateModule(m => ({
      ...m,
      vibrationIntervals: (m.vibrationIntervals || [])
        .filter(iv => !iv.sharedJobId || jobIds.has(iv.sharedJobId))
        .map(iv => iv.sharedJobId ? iv : { ...iv, sharedJobId: firstId })
    }));
  }, [jobs]); // eslint-disable-line react-hooks/exhaustive-deps

  const allIntervals = mod.vibrationIntervals || [];
  const firstJobId = jobs[0]?.id || '';
  const activeJobId = jobs.find(j => j.id === selectedJobId) ? selectedJobId : firstJobId;

  const visibleIntervals = useMemo(() => {
    if (jobs.length === 0) return allIntervals;
    return allIntervals.filter(iv => (iv.sharedJobId || firstJobId) === activeJobId);
  }, [jobs.length, allIntervals, firstJobId, activeJobId]);

  const globalIndex = useMemo(() => {
    if (selectedIndex < 0 || selectedIndex >= visibleIntervals.length) return -1;
    const iv = visibleIntervals[selectedIndex];
    return allIntervals.findIndex(x => x.id === iv.id);
  }, [visibleIntervals, selectedIndex, allIntervals]);

  const selectedInterval = globalIndex >= 0 ? allIntervals[globalIndex] : null;

  const handleJobChange = useCallback((jobId) => {
    setSelectedJobId(jobId);
    setSelectedIndex(0);
  }, []);

  const handleAdd = useCallback(() => {
    const existingCount = visibleIntervals.length;
    const newInterval = createVibrationInterval(existingCount, activeJobId);
    updateModule(m => ({ ...m, vibrationIntervals: [...(m.vibrationIntervals || []), newInterval] }));
    setSelectedIndex(existingCount);
  }, [visibleIntervals, activeJobId, updateModule]);

  const handleRemove = useCallback((visibleIdx) => {
    const iv = visibleIntervals[visibleIdx];
    if (!iv) return;
    const gIdx = allIntervals.findIndex(x => x.id === iv.id);
    if (gIdx < 0) return;
    updateModule(m => ({
      ...m,
      vibrationIntervals: (m.vibrationIntervals || []).filter((_, i) => i !== gIdx)
    }));
    setSelectedIndex(prev => {
      if (prev >= visibleIntervals.length - 1) return Math.max(0, visibleIntervals.length - 2);
      if (prev > visibleIdx) return prev - 1;
      return prev;
    });
  }, [visibleIntervals, allIntervals, updateModule]);

  const handleUpdate = useCallback((updated) => {
    if (globalIndex < 0) return;
    updateModule(m => {
      const next = [...(m.vibrationIntervals || [])];
      next[globalIndex] = updated;
      return { ...m, vibrationIntervals: next };
    });
  }, [globalIndex, updateModule]);

  const handleStatusChange = useCallback((next) => {
    updateModule(m => {
      const base = { ...m, vibrationExposureStatus: next };
      // '노출있음'으로 켤 때 구간이 없으면 첫 구간 seed
      if (next === 'present' && !(m.vibrationIntervals && m.vibrationIntervals.length)) {
        base.vibrationIntervals = [createVibrationInterval(0, jobs[0]?.id || '')];
      }
      return base;
    });
  }, [updateModule, jobs]);

  return (
    <div className="panel">
      <div className="section-header">
        <div className="section-title-row">
          <h2 className="section-title"><span className="section-icon">&#x303D;</span>전신진동 노출 평가</h2>
          <p className="section-description">직업별 진동 노출 구간을 입력합니다. 진동가속도(aw)는 최소~최대 범위로, 노출시간은 1일 총 노출시간으로 입력하세요.</p>
        </div>
      </div>

      {methodTabs}

      <div className="action-group" style={{ marginBottom: 12 }}>
        <span style={{ alignSelf: 'center', marginRight: 8, opacity: 0.8 }}>전신진동 노출 여부:</span>
        {WBV_STATUS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            className={`btn btn-sm ${status === opt.value ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => handleStatusChange(opt.value)}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {status !== 'present' ? (
        <div className="evaluation-empty-state">
          {status === 'none'
            ? '전신진동 노출 없음으로 평가됩니다.'
            : '전신진동 노출 여부를 선택하세요. "노출있음"을 선택하면 노출 구간을 입력할 수 있습니다.'}
        </div>
      ) : (
        <>
          {jobs.length > 1 && (
            <div className="action-group" style={{ marginBottom: 12 }}>
              {jobs.map((job, i) => {
                const isActive = activeJobId === job.id;
                const count = allIntervals.filter(iv => (iv.sharedJobId || firstJobId) === job.id).length;
                return (
                  <button
                    key={job.id}
                    className={`btn btn-sm ${isActive ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleJobChange(job.id)}
                  >
                    직력{i + 1}: {job.jobName || '(미입력)'} · {getEffectiveWorkPeriodText(job)}
                    <span style={{ marginLeft: 4, opacity: 0.7 }}>[{count}]</span>
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
            <VibrationIntervalManager
              intervals={visibleIntervals}
              selectedIndex={selectedIndex}
              onSelect={setSelectedIndex}
              onAdd={handleAdd}
              onRemove={handleRemove}
              disabled={jobs.length === 0}
            />
            <VibrationIntervalEditor
              interval={selectedInterval}
              onChange={handleUpdate}
            />
          </div>

          {/* 장비별 진동가속도(aw) 참고표 — aw 입력값 가이드. 기본 접힘. */}
          <details className="wbv-reference" style={{ marginTop: 12 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>
              장비별 진동가속도(aw) 참고표 ▾
            </summary>
            <p className="section-description" style={{ marginTop: 8 }}>
              장비 종류별 대표 진동가속도(m/s²) 범위입니다. 주황색 막대가 일반적인 범위이며, aw 하한·상한 입력 시 참고하세요.
            </p>
            <img
              src="/images/wbv-acceleration-chart.png"
              alt="장비별 진동가속도(aw) 범위 차트"
              style={{ width: '100%', maxWidth: 880, height: 'auto', display: 'block', marginTop: 8 }}
            />
          </details>
        </>
      )}
    </div>
  );
}
