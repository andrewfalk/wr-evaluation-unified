import { BasicInfoForm, BasicInfoSidePanel } from './BasicInfoForm';
import { DiagnosisForm } from './DiagnosisForm';
import { AssessmentStep } from './AssessmentStep';
import { AIAnalysisPanel } from './AIAnalysisPanel';
import { VideoAnalysisStep } from './VideoAnalysisStep';
import { createDiagnosis } from '../utils/data';
import { buildAiInputResult } from '../utils/aiInput';
import { hasUnmigratedLegacyJobData } from '@analytics-core/jobScope';

export function StepContent({
  currentStep,
  activePatient,
  shared, diagnoses, activeModules, allModules, suggested,
  activeModuleId, EvaluationComponent, calc, unifiedPreviewText,
  errors, settings, session,
  presets, presetMeta, presetError,
  aiAvailable,
  videoAnalysisFixtureMode,
  serverConfig,
  updatePatient, updateShared, updateModule, updateModuleById, updateDiagnoses, updateActiveModules,
  handlePresetSelect, setPresetModalJobId, setPresetBrowseJobId,
  onVideoServerApplied,
  onAssessmentEditingChange,
  canMutate = true,
}) {
  if (!currentStep || !activePatient) return null;

  // 모든 스텝 분기를 내부 함수로 캡슐화 → 공통 read-only wrapper로 마지막에 감쌈
  const renderStepContent = () => {
    if (currentStep.id === 'info') {
      return (
        <>
          <div className="panel">
            <BasicInfoForm shared={shared} onChange={updateShared} errors={errors} presets={presets} presetMeta={presetMeta} presetError={presetError} onPresetSelect={handlePresetSelect} onSavePreset={setPresetModalJobId} onBrowsePreset={setPresetBrowseJobId} activeModules={activeModules} session={session} legacyExclusionBlocked={hasUnmigratedLegacyJobData(activePatient.data?.modules)} />
          </div>
          <div className="panel">
            <BasicInfoSidePanel shared={shared} onChange={updateShared} session={session} />
          </div>
        </>
      );
    }
    if (currentStep.id === 'diagnosis') {
      return (
        <div className="panel">
          <DiagnosisForm
            diagnoses={diagnoses}
            onChange={updateDiagnoses}
            errors={errors}
            createDiagnosis={createDiagnosis}
            showModuleHints
            activeModules={activeModules}
          />
        </div>
      );
    }
    if (currentStep.id === 'modules') {
      return (
        <div className="panel">
          <section className="section pattern-surface form-section">
            <div className="section-header">
              <div className="section-title-row">
                <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>활성 평가 모듈</h2>
                <p className="section-description">상병에 따라 자동 추천됩니다. 수동으로 추가하거나 제거할 수도 있습니다.</p>
              </div>
            </div>
            <div className="module-check-cards">
              {allModules.map(mod => {
                const isSuggested = suggested.includes(mod.id);
                const isActive = activeModules.includes(mod.id);
                return (
                  <label key={mod.id} className={`module-check-card ${isActive ? 'active' : ''} ${isSuggested ? 'suggested' : ''}`}>
                    <input type="checkbox" checked={isActive} onChange={() => {
                      const updated = isActive ? activeModules.filter(id => id !== mod.id) : [...activeModules, mod.id];
                      updateActiveModules(updated);
                    }} />
                    <span className="module-check-icon">{mod.icon}</span>
                    <div>
                      <div className="module-check-name">{mod.name}</div>
                      <div className="module-check-copy">{mod.description}</div>
                    </div>
                    {isSuggested && <span className="module-check-badge">추천</span>}
                  </label>
                );
              })}
            </div>
          </section>
        </div>
      );
    }
    if (currentStep.id === 'videoAnalysis') {
      return (
        <VideoAnalysisStep
          shared={shared}
          updateShared={updateShared}
          updatePatient={updatePatient}
          activePatient={activePatient}
          activeModules={activeModules}
          session={session}
          settings={settings}
          fixtureMode={videoAnalysisFixtureMode}
          serverConfig={serverConfig}
          onServerApplied={onVideoServerApplied}
        />
      );
    }
    if (currentStep.id === 'assessment') {
      return (
        <AssessmentStep
          patient={activePatient}
          activeModules={activeModules}
          updateDiagnoses={updateDiagnoses}
          updateModuleById={updateModuleById}
          updateShared={updateShared}
          canMutate={canMutate}
          onEditingChange={onAssessmentEditingChange}
        />
      );
    }
    if (currentStep.id === 'ai') {
      return (
        <AIAnalysisPanel
          generatePrompt={() => unifiedPreviewText}
          buildInput={() => buildAiInputResult(activePatient)}
          fullReportAllowed={serverConfig?.aiFullReportAllowed === true}
          title="AI 업무관련성 종합분석"
          aiAvailable={aiAvailable}
        />
      );
    }
    if (currentStep.moduleId && EvaluationComponent) {
      return (
        <EvaluationComponent
          patient={{
            ...activePatient,
            moduleId: activeModuleId,
            data: {
              shared: activePatient.data.shared,
              module: activePatient.data.modules?.[activeModuleId] || {}
            }
          }}
          calc={calc}
          activeTab={currentStep.tabId}
          setActiveTab={() => {}}
          updateShared={updateShared}
          updateModule={updateModule}
          updateDiagnoses={updateDiagnoses}
          errors={errors}
          settings={settings}
          previewText={unifiedPreviewText}
          canMutate={canMutate}
        />
      );
    }
    return null;
  };

  const content = renderStepContent();
  const readOnly = !canMutate;
  // readOnly 여부와 무관하게 항상 같은 래퍼 요소를 렌더한다(핸들러/클래스만 조건부) —
  // 이전에는 read-only일 때만 <div>로 감싸서 반환했는데, 잠금 상실 등으로 readOnly가
  // 바뀌면 이 위치의 루트 요소 구조가 달라져 자식(AssessmentStep 등)이 재마운트되고
  // 편집 중이던 로컬 draft가 통째로 사라지는 문제가 있었다. .step-content-shell이
  // display: contents라 두 상태의 레이아웃은 동일하다(index.css).
  //
  // 이전에는 HTML inert 속성으로 전체를 막았으나, inert는 텍스트 선택(복사)과 스크롤까지
  // 차단해버려 비담당 환자의 내용을 읽을 수조차 없었다. 대신 capture-phase 이벤트 핸들러로
  // "상호작용(클릭/입력/붙여넣기/드롭)"만 막고, 텍스트 선택·복사·스크롤은 그대로 허용한다.
  // 서버(assignedDoctorOrAdmin 403)와 usePatientCrud silent guard가 실제 데이터 변경의
  // 최종 방어선이므로, 여기서는 UI 상호작용을 명확히 차단하는 역할만 한다.
  // banner는 부모(App.jsx)에서 스텝 탭 아래에 직접 렌더.
  const readOnlyProps = readOnly ? {
    onClickCapture: blockInteraction,
    onKeyDownCapture: blockMutatingKeys,
    onBeforeInputCapture: blockInteraction,
    onInputCapture: blockInteraction,
    onChangeCapture: blockInteraction,
    onPasteCapture: blockInteraction,
    onCutCapture: blockInteraction,
    onDropCapture: blockInteraction,
    onSubmitCapture: blockInteraction,
  } : {};
  return (
    <div className={`step-content-shell${readOnly ? ' read-only-content' : ''}`} {...readOnlyProps}>
      {content}
    </div>
  );
}

// data-readonly-allow 조상이 있는 요소는 예외 통로(향후 조회 전용 토글 등).
// 사용 규칙: 개별 조회 전용 컨트롤(버튼 하나)에만 부착할 것 — 넓은 컨테이너에 붙이면
// 하위 편집 요소까지 통째로 우회되므로 금지.
// (export: 단위 테스트에서 최소 DOM harness로 직접 검증하기 위함)
export function isReadOnlyAllowed(e) {
  return e.target instanceof Element && e.target.closest('[data-readonly-allow]');
}

export function blockInteraction(e) {
  if (isReadOnlyAllowed(e)) return;
  e.preventDefault();
  e.stopPropagation();
}

// 폼 컨트롤의 "값을 바꾸는" keydown만 네이티브 처리 전에 차단.
// input/change 전파 차단만으로는 네이티브 값 변경이 이미 일어난 뒤라
// (state 변경이 없으면 재렌더도 보장되지 않아) 화면에 바뀐 값이 남을 수 있다.
export function blockMutatingKeys(e) {
  if (isReadOnlyAllowed(e)) return;
  if (e.ctrlKey || e.metaKey) return; // Ctrl/Cmd+C 등 복사·단축키 허용
  if (e.key === 'Tab' || e.key === 'Shift' || e.key === 'Escape') return; // 포커스 이동 허용
  const t = e.target;
  if (!(t instanceof Element)) return;
  // 값 증감/토글형 컨트롤: 방향키·Space·Enter 등이 곧 편집이므로 전부 차단
  const isMutatingControl = t.matches(
    'select, input[type="checkbox"], input[type="radio"], input[type="range"], ' +
    'input[type="number"], input[type="date"], input[type="time"], input[type="month"], ' +
    'input[type="week"], input[type="color"], input[type="file"]'
  );
  // 커스텀 인터랙티브 요소(onKeyDown 부작용 방어): Enter/Space 활성화만 차단
  const isCustomInteractive = t.matches(
    '[role="button"], [role="switch"], [role="menuitem"], [role="tab"], ' +
    '[tabindex]:not(input):not(textarea):not(select)'
  );
  if (isMutatingControl || (isCustomInteractive && (e.key === 'Enter' || e.key === ' '))) {
    e.preventDefault();
    e.stopPropagation();
  }
  // 텍스트 계열 input/textarea는 건드리지 않음: 문자 입력·삭제는 beforeinput이 이미 차단하고,
  // 방향키/Home/End/Shift+방향키는 캐럿 이동·선택(복사용)이라 허용해야 함.
  // 일반 컨테이너(스크롤 영역)도 건드리지 않음: 방향키·PageDown 스크롤 유지.
}
