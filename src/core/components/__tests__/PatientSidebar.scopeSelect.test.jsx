// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PatientSidebar } from '../PatientSidebar.jsx';

afterEach(cleanup);

const roster = {
  doctors: [
    { userId: 'doc-a', name: '김의사', count: 3 },
    { userId: 'doc-b', name: '이의사', count: 1 },
  ],
  unassignedCount: 2,
};

function baseProps(overrides = {}) {
  return {
    showSidebar: true,
    onClose: vi.fn(),
    patients: [],
    displayPatients: [],
    activeId: null,
    filters: {},
    setFilters: vi.fn(),
    selectedIds: new Set(),
    setSelectedIds: vi.fn(),
    onAddPatient: vi.fn(),
    onShowBatchImport: vi.fn(),
    onSwitchPatient: vi.fn(),
    onRemovePatient: vi.fn(),
    onRemoveSelectedPatients: vi.fn(),
    onResolveConflict: vi.fn(),
    scope: 'mine',
    onScopeChange: vi.fn(),
    doctorRoster: roster,
    serverUnassignedCount: null,
    ...overrides,
  };
}

function doctorSession(userId = 'me') {
  return { mode: 'intranet', user: { id: userId, role: 'doctor' } };
}

function adminSession(userId = 'admin-1') {
  return { mode: 'intranet', user: { id: userId, role: 'admin' } };
}

describe('PatientSidebar scope select', () => {
  it('shows a "내 담당" option for a doctor session, with the roster-provided count', () => {
    render(<PatientSidebar {...baseProps({ session: doctorSession() })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    const mineOption = within(select).getByText(/내 담당/);
    expect(mineOption.textContent).toBe('내 담당 (0명)'); // 'me'는 roster.doctors에 없음(본인 제외 규칙) → myCount 0
  });

  it('does not show a "내 담당" option for an admin session', () => {
    render(<PatientSidebar {...baseProps({ session: adminSession(), scope: 'all' })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    expect(within(select).queryByText(/내 담당/)).toBeNull();
  });

  it('lists each roster doctor plus an unassigned option, count-labeled', () => {
    render(<PatientSidebar {...baseProps({ session: adminSession(), scope: 'all' })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    expect(within(select).getByText('김의사 (3명)')).toBeTruthy();
    expect(within(select).getByText('이의사 (1명)')).toBeTruthy();
    expect(within(select).getByText('미배정/알 수 없음 (2명)')).toBeTruthy();
  });

  it('calls onScopeChange with the selected doctor userId', async () => {
    const onScopeChange = vi.fn();
    render(<PatientSidebar {...baseProps({ session: adminSession(), scope: 'all', onScopeChange })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    const user = userEvent.setup();
    await user.selectOptions(select, 'doc-b');
    expect(onScopeChange).toHaveBeenCalledWith('doc-b');
  });

  it('renders a hidden "불러오는 중…" fallback option so the select is not blank while roster has not loaded the current scope yet', () => {
    // roster에 아직 없는 의사 UUID가 scope로 선택된 상태(명부 로딩 중 시나리오)
    render(<PatientSidebar {...baseProps({ session: adminSession(), scope: 'doc-not-yet-loaded' })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    expect(select.value).toBe('doc-not-yet-loaded');
    expect(within(select).getByText('불러오는 중…')).toBeTruthy();
  });

  it('does not show the loading fallback once the scope matches a real roster entry', () => {
    render(<PatientSidebar {...baseProps({ session: adminSession(), scope: 'doc-a' })} />);
    const select = screen.getByLabelText('담당 의사별 환자 필터');
    expect(within(select).queryByText('불러오는 중…')).toBeNull();
  });

  it('does not render the scope select outside intranet mode', () => {
    render(<PatientSidebar {...baseProps({ session: { mode: 'local' } })} />);
    expect(screen.queryByLabelText('담당 의사별 환자 필터')).toBeNull();
  });
});
