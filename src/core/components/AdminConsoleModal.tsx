// 관리자 콘솔 — 탭 목록과 본체. 탭 9개와 공용 조각은 ./admin/에 있다(P2-82a·b). 한 번에 한 탭만 그리므로 탭을 바꾸면 그 탭의 상태가 사라지고 다시 불러온다.
import { useState } from 'react';
import type { AdminSession } from './admin/shared';
import { AuditTab } from './admin/AuditTab';
import { DevicesTab } from './admin/DevicesTab';
import { UsersTab } from './admin/UsersTab';
import { SignupRequestsTab } from './admin/SignupRequestsTab';
import { PresetsTab } from './admin/PresetsTab';
import { PatientAssignmentTab } from './admin/PatientAssignmentTab';
import { InferenceDeviceTab } from './admin/InferenceDeviceTab';
import { CapabilitiesTab } from './admin/CapabilitiesTab';
import { OpsTab } from './admin/OpsTab';

// ── Main ──────────────────────────────────────────────────────────────────────
const TABS = [
  { id: 'audit',      label: '감사 로그' },
  { id: 'devices',    label: '디바이스' },
  { id: 'users',      label: '사용자 관리' },
  { id: 'requests',   label: '가입 요청' },
  { id: 'presets',    label: '프리셋 공유' },
  { id: 'assignment', label: '환자 배정' },
  { id: 'inference',  label: '추론 디바이스' },
  { id: 'capabilities', label: '통계 권한' },
  { id: 'ops',        label: '운영 상태' },
];

export interface AdminConsoleModalProps {
  session: AdminSession;
  onClose: () => void;
  onPatientAssignmentChanged?: () => unknown;
}

export function AdminConsoleModal({ session, onClose, onPatientAssignmentChanged }: AdminConsoleModalProps) {
  const [activeTab, setActiveTab] = useState('audit');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal admin-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-section-header">
          <div>
            <h2>관리자 콘솔</h2>
            <p className="modal-section-description">감사 로그, 디바이스, 계정을 관리합니다.</p>
          </div>
        </div>

        <div className="admin-tabs">
          {TABS.map(t => (
            <button
              key={t.id}
              className={`admin-tab-btn${activeTab === t.id ? ' admin-tab-btn--active' : ''}`}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {activeTab === 'audit'      && <AuditTab              session={session} />}
        {activeTab === 'devices'    && <DevicesTab            session={session} />}
        {activeTab === 'users'      && <UsersTab              session={session} />}
        {activeTab === 'requests'   && <SignupRequestsTab     session={session} />}
        {activeTab === 'presets'    && <PresetsTab            session={session} />}
        {activeTab === 'assignment' && <PatientAssignmentTab  session={session} onPatientAssignmentChanged={onPatientAssignmentChanged} />}
        {activeTab === 'inference'  && <InferenceDeviceTab    session={session} />}
        {activeTab === 'capabilities' && <CapabilitiesTab     session={session} />}
        {activeTab === 'ops'        && <OpsTab                session={session} />}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>닫기</button>
        </div>
      </div>
    </div>
  );
}
