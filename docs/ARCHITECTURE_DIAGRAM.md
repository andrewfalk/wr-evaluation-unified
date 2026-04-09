# Architecture Diagram

code-review-graph 기반 아키텍처 다이어그램 (407 nodes, 2852 edges, 49 communities)

## 범례
- **초록(module)**: 평가 모듈 (knee, spine, shoulder)
- **파랑(core)**: 공유 UI 컴포넌트
- **주황(svc)**: 서비스 레이어 (데이터 동기화, 스토리지)
- **보라(util)**: 유틸리티 (계산, 내보내기, 마이그레이션)
- **회색(infra)**: 인프라 (Electron IPC, Vercel API)

## Diagram

```mermaid
graph TB

    subgraph APP["App.jsx - Entry Point"]
        c127["App / Router<br/>(25 nodes)"]
    end

    subgraph MODULES["Evaluation Modules"]
        KNEE["Knee Module<br/>(knee)"]
        SPINE["Spine / MDDM<br/>(spine)"]
        SHOULDER["Shoulder Module<br/>(shoulder)"]
    end

    subgraph CORE_COMP["Core Components"]
        BATCH["BatchExport / PatientList<br/>(12)"]
        FORMAT["ResultPanel / Format<br/>(12)"]
        BASIC["BasicInfoForm<br/>(6)"]
        DIAG["DiagnosisForm<br/>(4)"]
        AIPANEL["AIAnalysisPanel<br/>(3)"]
        MODSELECTOR["ModuleSelector<br/>(3)"]
        SETTINGS["SettingsModal<br/>(4)"]
    end

    subgraph CORE_SVC["Core Services"]
        STATUS_SVC["statusSync<br/>(22)"]
        WORKSPACE["workspaceService<br/>(15)"]
        PATIENT_SVC["patientRecords<br/>(12)"]
        REMOTE["remoteStorageService<br/>(9)"]
        ANALYZE["analysisClient<br/>(5)"]
    end

    subgraph CORE_UTILS["Core Utils"]
        EXPORT["excelExport<br/>(22)"]
        CALC1["calculations<br/>(17)"]
        COMPUTE["computeCalc<br/>(13)"]
        MIGRATE["data migration<br/>(8)"]
        STORAGE["storage<br/>(4)"]
    end

    subgraph AUTH["Auth"]
        SESSION["session<br/>(9)"]
        AUTHCTX["AuthContext<br/>(4)"]
    end

    subgraph HOOKS["Hooks"]
        USE_AI["useAIAnalysis<br/>(2)"]
        USE_PATIENT["usePatientList<br/>(3)"]
        USE_INTRANET["useIntranet<br/>(3)"]
    end

    subgraph ELECTRON["Electron Desktop"]
        MAIN["main.js / IPC<br/>(17)"]
        EMR["EmrHelper.cs<br/>(45)"]
    end

    subgraph API["Vercel Serverless"]
        API_HANDLER["api/analyze.js<br/>(4)"]
    end

    %% App -> Core
    c127 --> WORKSPACE
    c127 --> PATIENT_SVC
    c127 --> MODSELECTOR

    %% Workspace orchestrates
    WORKSPACE -->|18| STATUS_SVC
    WORKSPACE --> PATIENT_SVC
    WORKSPACE --> REMOTE

    %% Services
    REMOTE --> PATIENT_SVC
    STATUS_SVC --> REMOTE

    %% Auth
    AUTHCTX --> SESSION
    USE_AI --> AUTHCTX
    USE_AI --> ANALYZE

    %% AI path branching
    ANALYZE -->|web| API_HANDLER
    ANALYZE -->|electron| MAIN

    %% Modules use utils
    KNEE --> CALC1
    SPINE --> COMPUTE
    KNEE --> EXPORT
    SPINE --> EXPORT

    %% Components
    BATCH --> PATIENT_SVC
    BATCH --> EXPORT
    AIPANEL --> USE_AI

    %% Electron
    MAIN --> EMR

    %% Styles
    classDef module fill:#4CAF50,stroke:#388E3C,color:#fff
    classDef core fill:#2196F3,stroke:#1565C0,color:#fff
    classDef svc fill:#FF9800,stroke:#E65100,color:#fff
    classDef util fill:#9C27B0,stroke:#6A1B9A,color:#fff
    classDef infra fill:#607D8B,stroke:#37474F,color:#fff

    class KNEE,SPINE,SHOULDER module
    class BATCH,FORMAT,BASIC,DIAG,AIPANEL,MODSELECTOR,SETTINGS core
    class STATUS_SVC,WORKSPACE,PATIENT_SVC,REMOTE,ANALYZE svc
    class EXPORT,CALC1,COMPUTE,MIGRATE,STORAGE util
    class MAIN,EMR,API_HANDLER infra
```
