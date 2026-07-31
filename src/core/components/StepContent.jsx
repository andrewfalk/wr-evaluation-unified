import { BasicInfoForm, BasicInfoSidePanel } from './BasicInfoForm';
import { DiagnosisForm } from './DiagnosisForm';
import { AssessmentStep } from './AssessmentStep';
import { AIAnalysisPanel } from './AIAnalysisPanel';
import { VideoAnalysisStep } from './VideoAnalysisStep';
import { createDiagnosis } from '../utils/data';

const UNIFIED_AI_SYSTEM_PROMPT = `당신은 직업성 근골격계 질환 업무관련성 평가 전문 직업환경의학 전문의입니다.
무릎(슬관절) 및 척추(요추) 평가 모두에 전문성을 갖추고 있습니다.
다음 지침에 따라 분석하세요:
1. 무릎: 신체부담정도 4단계(고도/중등도상/중등도하/경도)와 신체부담기여도 공식을 정확히 적용
2. 척추: ① MDDM 공식(F = b + m·L)과 G1~G11 자세 분류, 독일 법원(BSG) 기준(남 12.5 MN·h, 여 8.5 MN·h) 적용 ② 전신진동(BK2110): 일일 Amax(8)≥0.63 m/s², 평생 누적용량 DV,RI=1400 (m/s²)² 기준 적용
3. 한국 산재보상보험법 기준을 참조하여 업무관련성을 판단
4. 분석 결과는 한국어로 작성하고, 전문 용어는 명확히 설명
5. 구체적이고 실행 가능한 의견을 제시`;

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
  canMutate = true,
}) {
  if (!currentStep || !activePatient) return null;

  // 모든 스텝 분기를 내부 함수로 캡슐화 → 공통 read-only wrapper로 마지막에 감쌈
  const renderStepContent = () => {
    if (currentStep.id === 'info') {
      return (
        <>
          <div className="panel">
            <BasicInfoForm shared={shared} onChange={updateShared} errors={errors} presets={presets} presetMeta={presetMeta} presetError={presetError} onPresetSelect={handlePresetSelect} onSavePreset={setPresetModalJobId} onBrowsePreset={setPresetBrowseJobId} activeModules={activeModules} session={session} />
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
        />
      );
    }
    if (currentStep.id === 'ai') {
      return (
        <AIAnalysisPanel
          generatePrompt={() => unifiedPreviewText}
          systemPrompt={`${UNIFIED_AI_SYSTEM_PROMPT}\n6. 팔꿈치: BK 유형별 노출 패턴, 시간적 선후관계, 직업별-진단별 narrative를 함께 검토합니다.`}
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
        />
      );
    }
    return null;
  };

  const content = renderStepContent();
  const readOnly = !canMutate;
  if (!readOnly) return content;
  // read-only: 자식을 그대로 노출(display: contents)해 부모 grid/flex 레이아웃 보존.
  // banner는 부모(App.jsx)에서 스텝 탭 아래에 직접 렌더.
  //
  // 이전에는 HTML inert 속성으로 전체를 막았으나, inert는 텍스트 선택(복사)과 스크롤까지
  // 차단해버려 비담당 환자의 내용을 읽을 수조차 없었다. 대신 capture-phase 이벤트 핸들러로
  // "상호작용(클릭/입력/붙여넣기/드롭)"만 막고, 텍스트 선택·복사·스크롤은 그대로 허용한다.
  // 서버(assignedDoctorOrAdmin 403)와 usePatientCrud silent guard가 실제 데이터 변경의
  // 최종 방어선이므로, 여기서는 UI 상호작용을 명확히 차단하는 역할만 한다.
  return (
    <div
      className="read-only-content"
      aria-disabled="true"
      onClickCapture={blockInteraction}
      onKeyDownCapture={blockMutatingKeys}
      onBeforeInputCapture={blockInteraction}
      onInputCapture={blockInteraction}
      onChangeCapture={blockInteraction}
      onPasteCapture={blockInteraction}
      onCutCapture={blockInteraction}
      onDropCapture={blockInteraction}
      onSubmitCapture={blockInteraction}
    >{content}</div>
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
