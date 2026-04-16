import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { getModule, getAllModules } from './core/moduleRegistry';
import { BasicInfoForm, BasicInfoSidePanel } from './core/components/BasicInfoForm';
import { DiagnosisForm } from './core/components/DiagnosisForm';
import { AssessmentStep } from './core/components/AssessmentStep';
import { AIAnalysisPanel } from './core/components/AIAnalysisPanel';
import { IntegrationStatusBadge } from './core/components/IntegrationStatusBadge';
import { SettingsModal } from './core/components/SettingsModal';
import { BatchImportModal } from './core/components/BatchImportModal';
import Dashboard from './core/components/Dashboard';
import { useAuth } from './core/auth/AuthContext';
import { useIntegrationStatus } from './core/hooks/useIntegrationStatus';
import { usePatientList } from './core/hooks/usePatientList';
import { createSharedData, createDiagnosis, createTestPatients, formatBirthDate, DEFAULT_SETTINGS, FONT_SIZE_MAP } from './core/utils/data';
import { FALLBACK_PRESETS } from './modules/knee/utils/data';
import { suggestModules } from './core/utils/diagnosisMapping';
import { showAlert, showConfirm } from './core/utils/platform';
import { getSyncedEvaluationDate, isPatientComplete } from './core/utils/patientCompletion';
import { generateUnifiedReport } from './core/utils/reportGenerator';
import {
  createManagedPatient,
  clonePatientRecordForImport,
  migratePatientRecords,
  touchPatientRecord,
} from './core/services/patientRecords';
import {
  clearAutoSavedWorkspace,
  deleteWorkspaceSnapshot,
  hasDuplicateWorkspaceName,
  loadAppSettings,
  loadAppSettingsAsync,
  loadAutoSavedWorkspace,
  loadSavedWorkspaces,
  migrateWorkspaceStorage,
  saveAppSettings,
  saveAutoSavedWorkspace,
  saveWorkspaceSnapshot,
} from './core/services/workspaceRepository';

// 모듈 등록 (사이드이펙트 import)
import './modules/knee';
import './modules/spine';
import './modules/shoulder';
import './modules/elbow';

const UNIFIED_AI_SYSTEM_PROMPT = `당신은 직업성 근골격계 질환 업무관련성 평가 전문 직업환경의학 전문의입니다.
무릎(슬관절) 및 척추(요추) 평가 모두에 전문성을 갖추고 있습니다.
다음 지침에 따라 분석하세요:
1. 무릎: 신체부담정도 4단계(고도/중등도상/중등도하/경도)와 신체부담기여도 공식을 정확히 적용
2. 척추: MDDM 공식(F = b + m·L)과 G1~G11 자세 분류, DWS2 기준(남 7.0 MN·h, 여 3.0 MN·h) 적용
3. 한국 산재보상보험법 기준을 참조하여 업무관련성을 판단
4. 분석 결과는 한국어로 작성하고, 전문 용어는 명확히 설명
5. 구체적이고 실행 가능한 의견을 제시`;

// --- 스텝 빌더 ---
function buildSteps(activeModules) {
  const steps = [
    { id: 'info', label: '기본정보', group: 'shared' },
    { id: 'diagnosis', label: '상병 입력', group: 'shared' },
    { id: 'modules', label: '모듈 선택', group: 'shared' },
  ];
  for (const moduleId of activeModules) {
    const mod = getModule(moduleId);
    if (!mod) continue;
    for (const tab of mod.tabs) {
      steps.push({
        id: `${moduleId}:${tab.id}`,
        label: tab.label,
        group: moduleId,
        moduleId,
        tabId: tab.id,
        icon: mod.icon,
        moduleName: mod.name,
      });
    }
  }
  if (activeModules.length > 0) {
    steps.push({ id: 'assessment', label: '종합소견', group: 'shared' });
    steps.push({ id: 'ai', label: 'AI 분석', group: 'shared' });
  }
  return steps;
}

function App() {
  const { session, setSession } = useAuth();
  const [patients, setPatients] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  // 환자별 마지막 스텝 기억
  const [lastStepPerPatient, setLastStepPerPatient] = useState({});
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showLoadModal, setShowLoadModal] = useState(false);
  const [savedItems, setSavedItems] = useState([]);
  const [saveName, setSaveName] = useState('');
  const [errors, setErrors] = useState({});
  const [showSidebar, setShowSidebar] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState('default');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [lastAutoSave, setLastAutoSave] = useState(null);
  const [settings, setSettings] = useState(() => loadAppSettings(DEFAULT_SETTINGS));
  const [showSettings, setShowSettings] = useState(false);
  const [intakeShared, setIntakeShared] = useState(null);
  const [intakeStep, setIntakeStep] = useState(0);
  const [intakeSelectedModules, setIntakeSelectedModules] = useState([]);
  const [showBatchImport, setShowBatchImport] = useState(false);
  const [showHome, setShowHome] = useState(false);
  const [legacyItems, setLegacyItems] = useState(null);
  const [presets, setPresets] = useState([]);
  const [presetMeta, setPresetMeta] = useState(null);
  const [presetError, setPresetError] = useState(null);

  const { status: integrationStatus } = useIntegrationStatus({ session, settings });
  const activePatient = patients.find(p => p.id === activeId);
  const activeModules = activePatient?.data?.activeModules || [];

  // 현재 환자의 스텝 목록
  const steps = useMemo(() => buildSteps(activeModules), [activeModules]);
  const currentStep = steps[currentStepIndex] || steps[0];

  // 현재 스텝의 모듈 정보
  const activeModuleId = currentStep?.moduleId || null;
  const activeModule = activeModuleId ? getModule(activeModuleId) : null;

  // 테마/폰트 적용
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme);
    document.documentElement.style.fontSize = FONT_SIZE_MAP[settings.fontSize] || '16px';
  }, [settings.theme, settings.fontSize]);

  useEffect(() => {
    setSession(prev => {
      const nextMode = settings.integrationMode === 'intranet' ? 'intranet' : 'local';
      const nextBaseUrl = settings.apiBaseUrl || '';

      if (prev.mode === nextMode && (prev.apiBaseUrl || '') === nextBaseUrl) {
        return prev;
      }

      return {
        ...prev,
        mode: nextMode,
        apiBaseUrl: nextBaseUrl,
        refreshedAt: new Date().toISOString(),
      };
    });
  }, [setSession, settings.apiBaseUrl, settings.integrationMode]);

  // Electron: 파일 기반 설정 비동기 로드
  useEffect(() => {
    loadAppSettingsAsync(DEFAULT_SETTINGS).then(s => setSettings(s));
  }, []);

  useEffect(() => {
    migrateWorkspaceStorage();
  }, []);

  useEffect(() => {
    let cancelled = false;

    loadSavedWorkspaces({ session, settings })
      .then(items => {
        if (!cancelled) setSavedItems(items);
      })
      .catch(error => {
        console.error('[workspace-load]', error);
      });

    return () => { cancelled = true; };
  }, [
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.integrationMode,
    settings?.apiBaseUrl,
  ]);

  // 평가 완료 시 evaluationDate 자동 설정
  useEffect(() => {
    if (!activeId) return;
    const p = patients.find(x => x.id === activeId);
    if (!p) return;

    const nextEvaluationDate = getSyncedEvaluationDate(p);
    const currentEvaluationDate = p.data.shared?.evaluationDate || '';
    if (currentEvaluationDate === nextEvaluationDate) return;

    setPatients(prev => prev.map(x =>
      x.id === activeId
        ? touchPatientRecord(
          { ...x, data: { ...x.data, shared: { ...x.data.shared, evaluationDate: nextEvaluationDate } } },
          { session }
        )
        : x
    ));
  }, [activeId, patients, session]);

  // 프리셋 로딩
  useEffect(() => {
    fetch('./job-presets.json')
      .then(r => { if (!r.ok) throw new Error('Not found'); return r.json(); })
      .then(data => {
        setPresets(data.presets || []);
        setPresetMeta({ version: data.version, lastUpdated: data.lastUpdated, count: data.presets?.length });
      })
      .catch(() => {
        setPresets(FALLBACK_PRESETS);
        setPresetMeta({ version: 'fallback', count: FALLBACK_PRESETS.length });
        setPresetError('Preset 파일 로드 실패');
      });
  }, []);

  // 자동 저장 복원 (초기 1회만)
  useEffect(() => {
    loadAutoSavedWorkspace({ session, settings }).then(saved => {
      if (saved) {
        const time = new Date(saved.savedAt).toLocaleString('ko-KR');
        showConfirm(`이전 자동 저장 데이터가 있습니다 (${time}).\n이어서 작업하시겠습니까?`).then(ok => {
          if (ok && saved.patients?.length) {
            setPatients(saved.patients);
            setActiveId(saved.patients[0].id);
            setCurrentStepIndex(0);
          }
          clearAutoSavedWorkspace({ session, settings });
        });
      }
    });
  }, []);

  // 자동 저장
  useEffect(() => {
    if (!settings.autoSaveInterval || patients.length === 0) return;
    const timer = setTimeout(() => {
      saveAutoSavedWorkspace({ patients, session, settings });
      setLastAutoSave(new Date());
    }, settings.autoSaveInterval * 1000);
    return () => clearTimeout(timer);
  }, [
    patients,
    session?.mode,
    session?.apiBaseUrl,
    session?.user?.id,
    session?.user?.organizationId,
    settings?.autoSaveInterval,
    settings?.integrationMode,
    settings?.apiBaseUrl,
  ]);

  // Electron 메뉴 이벤트
  const handleStartIntakeRef = useRef(null);
  useEffect(() => {
    const unsubs = [];
    if (window.electron?.onMenuNew) {
      unsubs.push(window.electron.onMenuNew(() => { setPatients([]); setActiveId(null); setIntakeShared(null); }));
    }
    if (window.electron?.onGotoModule) {
      unsubs.push(window.electron.onGotoModule(() => { handleStartIntakeRef.current?.(); }));
    }
    return () => unsubs.forEach(fn => fn?.());
  }, []);

  const displayPatients = usePatientList(patients, searchQuery, sortKey, statusFilter);

  // 계산 결과
  const calc = useMemo(() => {
    if (!activePatient || !activeModule?.computeCalc) return {};
    return activeModule.computeCalc({
      shared: activePatient.data.shared,
      module: activePatient.data.modules?.[activeModuleId] || {}
    });
  }, [activePatient, activeModule, activeModuleId]);

  // 통합 미리보기 텍스트
  const unifiedPreviewText = useMemo(() => {
    if (!activePatient || activeModules.length === 0) return '';
    return generateUnifiedReport(activePatient);
  }, [activePatient, activeModules]);

  // --- 핸들러 ---

  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  const handleStartIntake = useCallback(() => {
    const s = settingsRef.current;
    const newShared = createSharedData();
    newShared.hospitalName = s.hospitalName;
    newShared.department = s.department;
    newShared.doctorName = s.doctorName;
    setIntakeShared(newShared);
    setIntakeStep(0);
    setIntakeSelectedModules([]);
    setShowHome(false);
  }, []);
  handleStartIntakeRef.current = handleStartIntake;

  const handleIntakeComplete = (selectedModuleIds) => {
    const modulesData = {};
    for (const moduleId of selectedModuleIds) {
      const mod = getModule(moduleId);
      if (mod?.createModuleData) modulesData[moduleId] = mod.createModuleData();
    }
    const p = createManagedPatient(selectedModuleIds, modulesData, { session });
    p.data.shared = { ...intakeShared };
    setPatients(prev => [...prev, p]);
    setActiveId(p.id);
    const newSteps = buildSteps(selectedModuleIds);
    const firstModuleIdx = newSteps.findIndex(s => s.group !== 'shared');
    setCurrentStepIndex(firstModuleIdx >= 0 ? firstModuleIdx : 0);
    setIntakeShared(null);
  };

  const updatePatient = (updater) => {
    setPatients(prev => prev.map(p =>
      p.id === activeId
        ? touchPatientRecord(
          {
            ...p,
            updatedAt: new Date().toISOString(),
            data: typeof updater === 'function' ? updater(p.data) : { ...p.data, ...updater }
          },
          { session }
        )
        : p
    ));
    if (Object.keys(errors).length) setErrors({});
  };

  const updateShared = (newShared) => {
    updatePatient(d => ({ ...d, shared: newShared }));
  };

  // 모듈 선택 변경 (환자정보 > 모듈 선택 스텝에서)
  const updateActiveModules = useCallback((newActiveModules) => {
    updatePatient(d => {
      const newModules = { ...d.modules };
      for (const moduleId of newActiveModules) {
        if (!newModules[moduleId]) {
          const mod = getModule(moduleId);
          if (mod?.createModuleData) newModules[moduleId] = mod.createModuleData();
        }
      }
      return { ...d, modules: newModules, activeModules: newActiveModules };
    });
  }, [activeId, session]);

  const updateModule = (updater) => {
    if (!activeModuleId) return;
    updatePatient(d => ({
      ...d,
      modules: {
        ...d.modules,
        [activeModuleId]: typeof updater === 'function'
          ? updater(d.modules?.[activeModuleId] || {})
          : { ...(d.modules?.[activeModuleId] || {}), ...updater }
      }
    }));
  };

  const updateModuleById = useCallback((moduleId, updater) => {
    updatePatient(d => ({
      ...d,
      modules: {
        ...d.modules,
        [moduleId]: typeof updater === 'function'
          ? updater(d.modules?.[moduleId] || {})
          : { ...(d.modules?.[moduleId] || {}), ...updater }
      }
    }));
  }, [activeId, session]);

  const updateDiagnoses = (newDiagnoses) => {
    updatePatient(d => ({ ...d, shared: { ...d.shared, diagnoses: newDiagnoses } }));
  };

  // 프리셋 선택 시 무릎 모듈 jobExtras 자동 채움
  const handlePresetSelect = useCallback((jobId, preset) => {
    setPatients(prev => prev.map(p => {
      if (p.id !== activeId) return p;
      const kneeData = p.data.modules?.knee;
      if (!kneeData) return p;
      const extras = [...(kneeData.jobExtras || [])];
      const idx = extras.findIndex(e => e.sharedJobId === jobId);
      if (idx >= 0) {
        extras[idx] = { ...extras[idx], weight: String(preset.weight), squatting: String(preset.squatting) };
      } else {
        extras.push({
          sharedJobId: jobId,
          weight: String(preset.weight),
          squatting: String(preset.squatting),
          evidenceSources: [],
          stairs: false, kneeTwist: false, startStop: false,
          tightSpace: false, kneeContact: false, jumpDown: false,
        });
      }
      return touchPatientRecord(
        { ...p, data: { ...p.data, modules: { ...p.data.modules, knee: { ...kneeData, jobExtras: extras } } } },
        { session }
      );
    }));
  }, [activeId, session]);

  const addPatient = () => { handleStartIntake(); };

  const removePatient = async (id) => {
    const confirmed = await showConfirm('이 환자를 삭제하시겠습니까?');
    if (!confirmed) return;
    if (patients.length <= 1) { setPatients([]); setActiveId(null); return; }
    const newPatients = patients.filter(p => p.id !== id);
    setPatients(newPatients);
    if (activeId === id) { setActiveId(newPatients[0].id); setCurrentStepIndex(0); }
  };

  const removeSelectedPatients = async () => {
    if (selectedIds.size === 0) return;
    if (selectedIds.size >= patients.length) { await showAlert('최소 1명의 환자는 유지해야 합니다'); return; }
    const confirmed = await showConfirm(`선택된 ${selectedIds.size}명의 환자를 삭제하시겠습니까?`);
    if (!confirmed) return;
    const newPatients = patients.filter(p => !selectedIds.has(p.id));
    setPatients(newPatients);
    if (selectedIds.has(activeId)) setActiveId(newPatients[0]?.id || null);
    setSelectedIds(new Set());
  };

  const handleBatchImport = (importedPatients, stats) => {
    const nextPatients = migratePatientRecords(importedPatients, { session });
    setPatients(nextPatients);
    if (nextPatients.length > 0) {
      setActiveId(nextPatients[nextPatients.length - 1].id);
      setCurrentStepIndex(0);
    }
    setIntakeShared(null);
    setShowHome(false);
    showAlert(`가져오기 완료: 신규 ${stats.newPatients}명, 상병 ${stats.newDiagnoses}건, 직업 ${stats.newJobs}건 추가 (중복 ${stats.skipped}건 건너뜀)`);
  };

  const handleLoadTestData = () => {
    const testPatients = migratePatientRecords(createTestPatients(), { session });
    setPatients(testPatients);
    if (testPatients.length > 0) {
      setActiveId(testPatients[0].id);
      setCurrentStepIndex(0);
    }
    setShowHome(false);
    showAlert(`테스트 데이터 로드 완료: ${testPatients.length}명`);
  };

  const handleSaveSettings = (newSettings) => {
    setSettings(newSettings);
    saveAppSettings(newSettings);
    setSession(prev => ({
      ...prev,
      mode: newSettings.integrationMode === 'intranet' ? 'intranet' : 'local',
      apiBaseUrl: newSettings.apiBaseUrl || '',
      refreshedAt: new Date().toISOString(),
    }));
    setShowSettings(false);
  };

  const handleResetPatients = async () => {
    const ok = await showConfirm('현재 작업 중인 환자 목록을 모두 삭제하시겠습니까?');
    if (!ok) return;
    setPatients([]);
    setActiveId(null);
    setIntakeShared(null);
    setShowHome(false);
    clearAutoSavedWorkspace({ session, settings });
  };

  const handleSave = async () => {
    if (!saveName.trim()) { await showAlert('저장명 필수'); return; }
    if (hasDuplicateWorkspaceName(saveName, savedItems)) {
      const confirmed = await showConfirm(`"${saveName}" 이름의 저장 데이터가 이미 존재합니다. 덮어쓰시겠습니까?`);
      if (!confirmed) return;
    }
    const items = await saveWorkspaceSnapshot({ name: saveName, patients, savedItems, session, settings });
    setSavedItems(items);
    setLastAutoSave(null);
    setShowSaveModal(false);
    setSaveName('');
    await showAlert('저장됨');
  };

  const handleOverwriteSave = async (item) => {
    const confirmed = await showConfirm(`"${item.name}"에 덮어쓰시겠습니까?`);
    if (!confirmed) return;
    const items = await saveWorkspaceSnapshot({ name: item.name, patients, savedItems, session, settings });
    setSavedItems(items);
    setLastAutoSave(null);
    setShowSaveModal(false);
    setSaveName('');
    await showAlert('저장됨');
  };

  const handleLoad = async (item, mode = 'overwrite') => {
    if (mode === 'overwrite') {
      const confirmed = await showConfirm('현재 데이터를 덮어쓰시겠습니까?');
      if (!confirmed) return;
      const nextPatients = migratePatientRecords(item.patients || [], { session });
      setPatients(nextPatients);
      setActiveId(nextPatients[0]?.id || null);
    } else {
      const newPatients = (item.patients || []).map(p => clonePatientRecordForImport(p, { session }));
      setPatients(prev => [...prev, ...newPatients]);
      setActiveId(newPatients[0]?.id || null);
    }
    setCurrentStepIndex(0);
    setShowLoadModal(false);
    setIntakeShared(null);
    setShowHome(false);
  };

  const handleDelete = async (id) => {
    const confirmed = await showConfirm('삭제하시겠습니까?');
    if (confirmed) {
      const items = await deleteWorkspaceSnapshot({ id, savedItems, session, settings });
      setSavedItems(items);
    }
  };

  const openLoadModal = () => {
    setShowLoadModal(true);
    // 레거시 데이터 감지
    if (window.electron?.loadLegacyData) {
      // Electron: IPC로 구형 앱 LevelDB 읽기
      window.electron.loadLegacyData().then(result => {
        // 디버그 로깅 (DevTools 콘솔에서 확인)
        if (result?.debug) console.log('[legacy-debug]', result.debug);
        const legacyData = result?.data || result; // 새 형식({ debug, data }) 또는 기존 형식 호환
        if (legacyData?.savedItems) {
          try {
            setLegacyItems(legacyData.savedItems.map(item => ({
              ...item,
              patients: item.patients ? migratePatientRecords(item.patients, { session }) : []
            })));
          } catch (e) {
            console.error('[legacy-migrate]', e);
            setLegacyItems(null);
          }
        } else {
          setLegacyItems(null);
        }
      }).catch((e) => { console.error('[legacy-error]', e); setLegacyItems(null); });
    } else {
      // 웹: 같은 도메인이면 localStorage 직접 접근
      try {
        const legacy = localStorage.getItem('wrEvaluationSavedItems');
        if (legacy) {
          const items = JSON.parse(legacy);
          setLegacyItems(items.map(item => ({
            ...item,
            patients: item.patients ? migratePatientRecords(item.patients, { session }) : []
          })));
        } else {
          setLegacyItems(null);
        }
      } catch { setLegacyItems(null); }
    }
  };

  const [exportDropdown, setExportDropdown] = useState(null);

  useEffect(() => {
    if (!exportDropdown) return;
    const close = () => setExportDropdown(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [exportDropdown]);

  const handleExportSingle = async () => {
    if (!activePatient) return;
    try {
      const { exportSingle } = await import('./core/utils/exportService');
      exportSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportSelected = async () => {
    try {
      const { exportSelected } = await import('./core/utils/exportService');
      await exportSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatch = async () => {
    try {
      const { exportBatch } = await import('./core/utils/exportService');
      await exportBatch(patients);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSingle = async () => {
    if (!activePatient) return;
    try {
      const { exportBatchFormatSingle } = await import('./core/utils/exportService');
      exportBatchFormatSingle(activePatient);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatSelected = async () => {
    try {
      const { exportBatchFormatSelected } = await import('./core/utils/exportService');
      await exportBatchFormatSelected(patients, selectedIds);
    } catch (err) { await showAlert(err.message); }
  };

  const handleExportBatchFormatAll = async () => {
    try {
      const { exportBatchFormatAll } = await import('./core/utils/exportService');
      await exportBatchFormatAll(patients);
    } catch (err) { await showAlert(err.message); }
  };

  const handleInjectEMR = async () => {
    if (!activePatient || !window.electron?.injectEMR) return;
    const ok = await showConfirm('EMR 소견서에 현재 환자 데이터를 직접 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { generateEMRFieldData } = await import('./core/utils/exportService');
      const fieldData = generateEMRFieldData(activePatient);
      const result = await window.electron.injectEMR(fieldData);
      if (result.success) {
        let msg = `${result.message}`;
        if (result.truncatedFields?.length > 0) {
          msg += `\n\n⚠ 길이 제한으로 잘린 필드: ${result.truncatedFields.join(', ')}`;
        }
        if (result.failedFields?.length > 0) {
          msg += `\n\n일부 실패:\n${result.failedFields.map(f => `- ${f.field}: ${f.reason}`).join('\n')}`;
        }
        await showAlert(msg);
      } else {
        await showAlert(`EMR 입력 실패: ${result.message}`);
      }
    } catch (err) { await showAlert('EMR 입력 오류: ' + err.message); }
  };

  // --- 스텝 네비게이션 ---
  const goToStep = (index) => {
    if (index >= 0 && index < steps.length) {
      // 현재 스텝 기억
      if (activeId) setLastStepPerPatient(prev => ({ ...prev, [activeId]: currentStepIndex }));
      setCurrentStepIndex(index);
    }
  };

  const goNext = () => goToStep(currentStepIndex + 1);
  const goPrev = () => goToStep(currentStepIndex - 1);

  // 환자 전환 시 마지막 스텝 복귀
  const switchPatient = (patientId) => {
    if (activeId) setLastStepPerPatient(prev => ({ ...prev, [activeId]: currentStepIndex }));
    setActiveId(patientId);
    setCurrentStepIndex(lastStepPerPatient[patientId] || 0);
    setShowSidebar(false);
  };

  // --- 저장 모달 ---
  const renderSaveModal = () => (
    <div className="modal-overlay" onClick={() => setShowSaveModal(false)}>
      <div className="modal save-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>저장</h2>
            <p className="modal-section-description">현재 {patients.length}명의 환자 데이터를 저장합니다.</p>
          </div>
        </div>
        <section className="modal-section pattern-surface">
          <div className="modal-section-header">
            <div>
              <h3 className="modal-section-title">새 저장</h3>
              <p className="modal-section-description">저장명을 입력해 새 항목으로 보관합니다.</p>
            </div>
          </div>
          <div className="form-group">
            <label>저장명</label>
            <input value={saveName} onChange={e => setSaveName(e.target.value)} autoFocus />
          </div>
          <div className="modal-actions">
            <button className="btn btn-primary" onClick={handleSave}>새로 저장</button>
            <button className="btn btn-secondary" onClick={() => setShowSaveModal(false)}>취소</button>
          </div>
        </section>
        {savedItems.length > 0 && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">기존 저장 목록</h3>
                <p className="modal-section-description">기존 항목을 선택해 바로 덮어쓸 수 있습니다.</p>
              </div>
              <span className="modal-section-badge">{savedItems.length}개</span>
            </div>
            <div className="modal-scroll-list">
              {savedItems.map(item => (
                <div key={item.id} className="saved-item">
                  <div className="saved-item-content">
                    <h4>{item.name}</h4>
                    <p>{item.count || 1}명 | {new Date(item.savedAt).toLocaleString('ko-KR')}</p>
                  </div>
                  <div className="saved-item-actions">
                    <button className="btn btn-primary btn-xs" onClick={() => handleOverwriteSave(item)}>덮어쓰기</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );

  // --- 불러오기 모달 ---
  const renderLoadModal = () => (
    <div className="modal-overlay" onClick={() => setShowLoadModal(false)}>
      <div className="modal load-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>불러오기</h2>
            <p className="modal-section-description">저장된 데이터를 덮어쓰거나 현재 목록에 추가할 수 있습니다.</p>
          </div>
          <span className="modal-section-badge">
            {(legacyItems?.length || 0) + savedItems.length}개 항목
          </span>
        </div>

        {/* 레거시 데이터 섹션 */}
        {legacyItems && legacyItems.length > 0 && (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">이전 프로그램(무릎) 데이터</h3>
                <p className="modal-section-description">레거시 저장본을 현재 통합 포맷으로 불러옵니다.</p>
              </div>
              <span className="modal-section-badge">{legacyItems.length}개</span>
            </div>
            {legacyItems.map((item, idx) => (
              <div key={`legacy-${idx}`} className="saved-item saved-item-legacy">
                <div className="saved-item-content">
                  <h4>{item.name}</h4>
                  <p>{item.count || item.patients?.length || 0}명 | {item.savedAt ? new Date(item.savedAt).toLocaleString('ko-KR') : '-'}</p>
                </div>
                <div className="saved-item-actions">
                  <button className="btn btn-primary btn-xs" onClick={() => handleLoad(item, 'overwrite')}>덮어쓰기</button>
                  <button className="btn btn-info btn-xs" onClick={() => handleLoad(item, 'append')}>추가</button>
                </div>
              </div>
            ))}
          </section>
        )}

        {/* 통합 프로그램 저장 데이터 */}
        {savedItems.length === 0 && (!legacyItems || legacyItems.length === 0) ? (
          <div className="modal-empty-state">저장 데이터 없음</div>
        ) : (
          <section className="modal-section pattern-surface">
            <div className="modal-section-header">
              <div>
                <h3 className="modal-section-title">통합 프로그램 저장 데이터</h3>
                <p className="modal-section-description">현재 앱에서 저장한 환자 데이터입니다.</p>
              </div>
              <span className="modal-section-badge">{savedItems.length}개</span>
            </div>
            {savedItems.map(item => (
              <div key={item.id} className="saved-item">
                <div className="saved-item-content">
                  <h4>{item.name}</h4>
                  <p>{item.count || 1}명 | {new Date(item.savedAt).toLocaleString('ko-KR')}</p>
                </div>
                <div className="saved-item-actions">
                  <button className="btn btn-primary btn-xs" onClick={() => handleLoad(item, 'overwrite')}>덮어쓰기</button>
                  <button className="btn btn-info btn-xs" onClick={() => handleLoad(item, 'append')}>추가</button>
                  <button className="btn btn-danger btn-xs" onClick={() => handleDelete(item.id)}>삭제</button>
                </div>
              </div>
            ))}
          </section>
        )}
        <div className="modal-actions modal-actions-stretch">
          <button className="btn btn-secondary" onClick={() => setShowLoadModal(false)}>닫기</button>
        </div>
      </div>
    </div>
  );

  // ===========================================
  // 랜딩 화면
  // ===========================================
  if ((patients.length === 0 && !activeId && !intakeShared) || showHome) {
    return (
      <div className="app-layout landing-layout">
        <div className="panel landing-panel pattern-surface pattern-surface-hero">
          <div className="landing-hero">
            <div className="section-title-row landing-hero-copy">
              <h1 className="landing-title">근골격계 질환 업무관련성 평가 및 특별진찰 소견서 작성 도우미</h1>
              <p className="landing-description">새 환자 평가를 시작하거나 저장된 데이터를 불러오세요.</p>
            </div>
          </div>
          <div className="landing-actions">
            <button className="btn btn-primary landing-action-btn" onClick={handleStartIntake}>+ 새환자</button>
            <button className="btn btn-secondary landing-action-btn" onClick={() => openLoadModal()}>불러오기</button>
            <button className="btn btn-secondary landing-action-btn" onClick={() => setShowSaveModal(true)}>저장</button>
            <button className="btn btn-info landing-action-btn" onClick={() => setShowBatchImport(true)}>엑셀 일괄입력</button>
            <button className="btn btn-warning landing-action-btn" onClick={handleLoadTestData}>테스트</button>
            <button className="btn btn-secondary landing-action-btn" onClick={() => setShowSettings(true)}>설정</button>
            {patients.length > 0 && (
              <>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowHome(false)}>
                  작업 목록 돌아가기 ({patients.length}명)
                </button>
                <button className="btn btn-danger btn-sm" onClick={handleResetPatients}>
                  목록 초기화
                </button>
              </>
            )}
          </div>
          <Dashboard patients={patients} onSelectPatient={(id) => { setActiveId(id); setCurrentStepIndex(0); setShowHome(false); }} />
        </div>
        {showSettings && (
          <SettingsModal
            settings={settings}
            session={session}
            integrationStatus={integrationStatus}
            onSave={handleSaveSettings}
            onClose={() => setShowSettings(false)}
          />
        )}
        {showSaveModal && renderSaveModal()}
        {showLoadModal && renderLoadModal()}
        {showBatchImport && <BatchImportModal onClose={() => setShowBatchImport(false)} onImport={handleBatchImport} existingPatients={patients} />}
      </div>
    );
  }

  // ===========================================
  // 신규 환자 위자드 (환자 생성 전)
  // ===========================================
  if (intakeShared) {
    const intakeSteps = [
      { id: 'info', label: '기본정보' },
      { id: 'diagnosis', label: '상병 입력' },
      { id: 'modules', label: '모듈 선택' },
    ];
    const intakeDiagnoses = intakeShared.diagnoses || [createDiagnosis()];
    const suggested = suggestModules(intakeDiagnoses);
    const allModules = getAllModules();

    // 모듈 선택 스텝 진입 시 추천 반영
    const goIntakeStep = (next) => {
      if (next === 2 && intakeSelectedModules.length === 0 && suggested.length > 0) {
        setIntakeSelectedModules([...suggested]);
      }
      setIntakeStep(next);
    };

    return (
      <div className="app-layout landing-layout">
        <div className="panel intake-panel pattern-surface pattern-surface-hero">
          <div className="intake-header">
            <div className="section-title-row">
              <h1 className="landing-title intake-title">새 환자 평가</h1>
              <p className="landing-description intake-description">기본정보, 상병, 모듈 선택 순서로 신규 환자를 등록합니다.</p>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => {
              setIntakeShared(null);
              if (patients.length > 0) setActiveId(patients[0].id);
            }}>
              {patients.length > 0 ? '돌아가기' : '취소'}
            </button>
          </div>

          {/* 스텝 인디케이터 */}
          <div className="wizard-steps">
            {intakeSteps.map((s, i) => (
              <div key={s.id} className={`wizard-step ${i === intakeStep ? 'active' : ''} ${i < intakeStep ? 'done' : ''}`}
                onClick={() => i < intakeStep && goIntakeStep(i)}>
                <span className="wizard-step-num">{i < intakeStep ? '✓' : i + 1}</span>
                <span className="wizard-step-label">{s.label}</span>
              </div>
            ))}
          </div>

          {/* Step 1: 기본정보 */}
          {intakeStep === 0 && (
            <>
              <BasicInfoForm shared={intakeShared} onChange={setIntakeShared} errors={errors} presets={presets} presetMeta={presetMeta} presetError={presetError} />
              <div className="wizard-actions">
                <span />
                <button className="btn btn-primary" onClick={() => goIntakeStep(1)}>다음: 상병 입력 &rarr;</button>
              </div>
            </>
          )}

          {/* Step 2: 상병 */}
          {intakeStep === 1 && (
            <>
              <DiagnosisForm
                diagnoses={intakeDiagnoses}
                onChange={newDiag => setIntakeShared(prev => ({ ...prev, diagnoses: newDiag }))}
                errors={errors}
                createDiagnosis={createDiagnosis}
                showModuleHints
              />
              <div className="wizard-actions">
                <button className="btn btn-secondary" onClick={() => goIntakeStep(0)}>&larr; 이전</button>
                <button className="btn btn-primary" onClick={() => goIntakeStep(2)}>다음: 모듈 선택 &rarr;</button>
              </div>
            </>
          )}

          {/* Step 3: 모듈 선택 */}
          {intakeStep === 2 && (
            <>
              <section className="section pattern-surface form-section">
                <div className="section-header">
                  <div className="section-title-row">
                    <h2 className="section-title"><span className="section-icon">&#x1F4CB;</span>평가 모듈 선택</h2>
                    <p className="section-description">입력된 상병을 기반으로 평가 모듈이 자동 추천되었습니다.</p>
                  </div>
                </div>
                <div className="module-check-cards">
                  {allModules.map(mod => {
                    const isSuggested = suggested.includes(mod.id);
                    const isSelected = intakeSelectedModules.includes(mod.id);
                    return (
                      <label key={mod.id} className={`module-check-card ${isSelected ? 'active' : ''} ${isSuggested ? 'suggested' : ''}`}>
                        <input type="checkbox" checked={isSelected} onChange={() => {
                          setIntakeSelectedModules(prev => prev.includes(mod.id) ? prev.filter(id => id !== mod.id) : [...prev, mod.id]);
                        }} />
                        <span className="module-check-icon">{mod.icon}</span>
                        <div>
                          <div className="module-check-name">{mod.name}</div>
                          <div className="module-check-copy">{mod.description}</div>
                        </div>
                        {isSuggested && <span className="module-check-badge">자동감지</span>}
                      </label>
                    );
                  })}
                </div>
              </section>
              <div className="wizard-actions">
                <button className="btn btn-secondary" onClick={() => goIntakeStep(1)}>&larr; 이전</button>
                <button className="btn btn-primary" onClick={() => handleIntakeComplete(intakeSelectedModules)}
                  disabled={intakeSelectedModules.length === 0}>
                  평가 시작 ({intakeSelectedModules.length}개 모듈)
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  // ===========================================
  // 메인 작업 화면 (위자드 전체 흐름)
  // ===========================================
  const shared = activePatient?.data?.shared || {};
  const diagnoses = shared.diagnoses || [];
  const allModules = getAllModules();
  const suggested = suggestModules(diagnoses);

  // 현재 스텝의 모듈에 대한 EvaluationComponent
  const EvaluationComponent = activeModule?.EvaluationComponent;


  // 스텝 인디케이터에서 그룹별 구분
  const renderStepIndicator = () => {
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
  };

  // 현재 스텝 콘텐츠 렌더링
  const renderStepContent = () => {
    if (!currentStep || !activePatient) return null;

    // 공유 스텝
    if (currentStep.id === 'info') {
      return (
        <>
          <div className="panel">
            <BasicInfoForm shared={shared} onChange={updateShared} errors={errors} presets={presets} presetMeta={presetMeta} presetError={presetError} onPresetSelect={handlePresetSelect} />
          </div>
          <div className="panel">
            <BasicInfoSidePanel shared={shared} onChange={updateShared} />
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

    // 종합소견
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

    // AI 종합분석
    if (currentStep.id === 'ai') {
      return (
        <AIAnalysisPanel
          generatePrompt={() => unifiedPreviewText}
          systemPrompt={`${UNIFIED_AI_SYSTEM_PROMPT}\n6. 팔꿈치: BK 유형별 노출 패턴, 시간적 선후관계, 직업별-진단별 narrative를 함께 검토합니다.`}
          title="AI 업무관련성 종합분석"
        />
      );
    }

    // 모듈 스텝
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

  // 헤더 타이틀
  const headerTitle = currentStep?.group === 'shared'
    ? currentStep.label
    : `${currentStep?.icon || ''} ${currentStep?.moduleName || ''} - ${currentStep?.label || ''}`;

  return (
    <div className="app-layout">
      {showSidebar && <div className="sidebar-overlay" onClick={() => setShowSidebar(false)} />}

      {/* 사이드바 */}
      <div className={`sidebar ${showSidebar ? 'sidebar-open' : ''}`}>
        <div className="sidebar-header">
          <h2>환자 목록 ({(searchQuery.trim() || statusFilter !== 'all') ? `${displayPatients.length}/${patients.length}` : patients.length})</h2>
          <div className="sidebar-actions">
            <button className="btn btn-primary btn-sm" onClick={addPatient} title="새 환자 추가">+ 추가</button>
            <button className="btn btn-info btn-sm" onClick={() => setShowBatchImport(true)} title="엑셀 일괄입력">일괄</button>
          </div>
        </div>
        <div className="sidebar-filter">
          <input type="search" placeholder="검색 (이름, 진단)" value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
          <div className="sidebar-selection-row">
            <input type="checkbox" checked={displayPatients.length > 0 && displayPatients.every(p => selectedIds.has(p.id))} onChange={e => {
              setSelectedIds(prev => {
                const next = new Set(prev);
                displayPatients.forEach(p => e.target.checked ? next.add(p.id) : next.delete(p.id));
                return next;
              });
            }} />
            <span className="sidebar-selection-label">전체선택{selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}</span>
            {selectedIds.size > 0 && <button className="btn btn-danger btn-xs sidebar-selection-delete" onClick={removeSelectedPatients}>삭제</button>}
          </div>
          <div className="sidebar-filter-row">
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">전체</option><option value="complete">완료</option><option value="incomplete">미완료</option>
            </select>
            <select value={sortKey} onChange={e => setSortKey(e.target.value)}>
              <option value="default">입력순</option><option value="name">이름순</option><option value="birthDate">생년월일순</option><option value="evaluationDate">평가일순</option>
            </select>
          </div>
        </div>
        <div className="patient-list">
          {displayPatients.map(p => {
            const origIndex = patients.indexOf(p);
            const pModules = p.data.activeModules || [];
            const isComplete = isPatientComplete(p);
            const patientName = p.data.shared?.name || `환자 #${origIndex + 1}`;
            const primaryDiagnosis = p.data.shared?.diagnoses?.[0]?.name || '-';
            return (
              <div key={p.id} className={`patient-item ${p.id === activeId ? 'active' : ''}`} onClick={() => switchPatient(p.id)}>
                <div className="patient-item-grid">
                  <div className="patient-item-select">
                    <input type="checkbox" checked={selectedIds.has(p.id)} onClick={e => e.stopPropagation()} onChange={() => {
                      setSelectedIds(prev => { const next = new Set(prev); next.has(p.id) ? next.delete(p.id) : next.add(p.id); return next; });
                    }} />
                  </div>
                  <div className="patient-item-content">
                    <div className="patient-item-top">
                      <div className="patient-item-name-row">
                        <span className="patient-item-title">{patientName}</span>
                        <div className="patient-item-modules">
                          {pModules.map(mId => { const mod = getModule(mId); return <span key={mId} className="module-badge" title={mod?.name}>{mod?.icon || '?'}</span>; })}
                        </div>
                      </div>
                      <span className={isComplete ? 'status-dot complete' : 'status-dot'} title={isComplete ? '완료' : '미완료'}>✓</span>
                    </div>
                    <div className="patient-item-info patient-item-meta">
                      <span>{formatBirthDate(p.data.shared?.birthDate)}</span>
                      <span className="patient-item-divider">•</span>
                      <span className="patient-item-diagnosis">{primaryDiagnosis}</span>
                    </div>
                    <div className="patient-item-actions">
                      <button className="btn btn-danger btn-xs" onClick={e => { e.stopPropagation(); removePatient(p.id); }}>삭제</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 메인 영역 */}
      <div className="main-area">
        <header className="header pattern-surface pattern-surface-hero">
          <div className="header-title-row">
            <h1>{headerTitle}</h1>
            {lastAutoSave && <span className="header-meta">자동저장 {lastAutoSave.toLocaleTimeString('ko-KR')}</span>}
          </div>
          <IntegrationStatusBadge status={integrationStatus} />
          <div className="header-actions action-bar">
            <div className="action-group">
              <button className="btn btn-secondary btn-sm" onClick={() => setShowHome(true)} title="대시보드로 이동">대시보드</button>
              <button className="btn btn-danger btn-sm" onClick={handleResetPatients} title="환자 목록 초기화">초기화</button>
              <button className="btn btn-secondary btn-sm sidebar-toggle" onClick={() => setShowSidebar(v => !v)}>환자 ({patients.length})</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSaveModal(true)}>저장</button>
              <button className="btn btn-secondary btn-sm" onClick={() => openLoadModal()}>불러오기</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowSettings(true)}>설정</button>
              {(activePatient && activeModules.length > 0) || selectedIds.size > 0 || patients.length > 0 ? (
                <>
                {activePatient && activeModules.length > 0 && (
                  <div className="action-menu">
                    <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'single' ? null : 'single'); }}>Excel(현재) ▾</button>
                    {exportDropdown === 'single' && (
                      <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
                        <button onClick={handleExportSingle}>EMR 형식</button>
                        <button onClick={handleExportBatchFormatSingle}>일괄입력용</button>
                        {window.electron?.injectEMR && (
                          <button className="dropdown-divider-top" onClick={handleInjectEMR}>EMR 직접입력</button>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {selectedIds.size > 0 && (
                  <div className="action-menu">
                    <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'selected' ? null : 'selected'); }}>Excel(선택 {selectedIds.size}) ▾</button>
                    {exportDropdown === 'selected' && (
                      <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
                        <button onClick={handleExportSelected}>EMR 형식</button>
                        <button onClick={handleExportBatchFormatSelected}>일괄입력용</button>
                      </div>
                    )}
                  </div>
                )}
                {patients.length > 0 && (
                  <div className="action-menu">
                    <button className="btn btn-success btn-sm" onClick={e => { e.stopPropagation(); setExportDropdown(v => v === 'batch' ? null : 'batch'); }}>Excel(전체) ▾</button>
                    {exportDropdown === 'batch' && (
                      <div className="export-dropdown" onClick={() => setExportDropdown(null)}>
                        <button onClick={handleExportBatch}>EMR 형식</button>
                        <button onClick={handleExportBatchFormatAll}>일괄입력용</button>
                      </div>
                    )}
                  </div>
                )}
                </>
              ) : null}
            </div>
          </div>
        </header>

        {activePatient && (
          <>
            {/* 스텝 인디케이터 */}
            {renderStepIndicator()}

            {/* 콘텐츠 */}
            <div className={`main-content ${currentStep.id === 'info' ? 'main-content-dual' : currentStep.id === 'assessment' ? '' : 'main-content-single'}`}>
              {renderStepContent()}
            </div>

            {/* 이전/다음 버튼 */}
            <div className="wizard-nav">
              <button className="btn btn-secondary" onClick={goPrev} disabled={currentStepIndex === 0}>
                &larr; 이전
              </button>
              <span className="wizard-nav-count">
                {currentStepIndex + 1} / {steps.length}
              </span>
              <button className="btn btn-primary" onClick={goNext} disabled={currentStepIndex >= steps.length - 1}>
                다음 &rarr;
              </button>
            </div>
          </>
        )}
      </div>

      {/* 모달들 */}
      {showSettings && (
        <SettingsModal
          settings={settings}
          session={session}
          integrationStatus={integrationStatus}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      )}
      {showSaveModal && renderSaveModal()}
      {showLoadModal && renderLoadModal()}
      {showBatchImport && <BatchImportModal onClose={() => setShowBatchImport(false)} onImport={handleBatchImport} existingPatients={patients} />}
    </div>
  );
}

export default App;
