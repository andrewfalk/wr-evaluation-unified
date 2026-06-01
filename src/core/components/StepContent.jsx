import { BasicInfoForm, BasicInfoSidePanel } from './BasicInfoForm';
import { DiagnosisForm } from './DiagnosisForm';
import { AssessmentStep } from './AssessmentStep';
import { AIAnalysisPanel } from './AIAnalysisPanel';
import { createDiagnosis } from '../utils/data';
import { canEditPatient } from '../utils/patientOwnership';

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
  updateShared, updateModule, updateModuleById, updateDiagnoses, updateActiveModules,
  handlePresetSelect, setPresetModalJobId, setPresetBrowseJobId,
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
    if (currentStep.id === 'assessment') {
      return (
        <AssessmentStep
          patient={activePatient}
          activeModules={activeModules}
          updateDiagnoses={updateDiagnoses}
          updateModuleById={updateModuleById}
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
  const readOnly = !canEditPatient(activePatient, session);
  if (!readOnly) return content;
  // read-only: 자식을 그대로 노출(display: contents)해 부모 grid/flex 레이아웃 보존.
  // banner는 부모(App.jsx)에서 스텝 탭 아래에 직접 렌더.
  // inert 속성: 키보드 포커스/탭 이동/스크린리더 상호작용까지 모두 차단 (pointer-events보다 강함).
  // HTML 표준 (2023+ Chrome/Edge/Safari/Firefox 모두 지원).
  // 서버/usePatientCrud silent guard가 실제 수정을 막지만 UI도 명확히 read-only로 표현.
  return (
    <div className="read-only-content" aria-disabled="true" inert="">{content}</div>
  );
}
