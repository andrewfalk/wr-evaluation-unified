// @vitest-environment jsdom
//
// 관리자 콘솔 — EMR 감사 기록의 비고(발생 시각·서버 표시)와 장치 목록의 같은 PC 표시, 장치 승인·해지 실패 문구(EA-10).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../services/httpClient', () => ({
  requestJson: vi.fn(),
}));

import { requestJson } from '../../services/httpClient';
import { AdminConsoleModal } from '../AdminConsoleModal.jsx';
import { emrAuditNote, devicesPerPc, deviceActionErrorMessage, EMR_AUDIT_FLAG_LABELS } from '../adminAuditNotes';

const SESSION = { mode: 'intranet', apiBaseUrl: 'https://srv', user: { id: 'admin-1', role: 'admin', organizationId: 'org-1' } };

const auditItem = (over) => ({
  id: crypto.randomUUID(), createdAt: '2026-11-24T01:00:00.000Z', actorUserId: 'user-1-aaaaaaaa', action: 'emr_extract_record',
  outcome: 'success', targetType: 'emr', targetId: 'abcdef0123', ip: '10.0.0.5', extra: {}, ...over,
});

afterEach(() => {
  cleanup();
  vi.mocked(requestJson).mockReset();
});

describe('adminAuditNotes', () => {
  it('EMR 기록의 비고: 발생 시각과 표시(정해진 순서), EMR이 아닌 기록은 없음', () => {
    expect(emrAuditNote({ targetType: 'emr', extra: { occurred_at: '2026-11-24T00:59:00.000Z', burst: true, legacy_shell: true, actor_uncertain: true } }))
      .toEqual({ occurredAt: '2026-11-24T00:59:00.000Z', flags: ['옛 설치본', '행위자 불확실', '몰아서 전송'] });
    expect(emrAuditNote({ targetType: 'emr', extra: { actor_unverified: true, org_unresolved: true, burst: 'true' } }))
      .toEqual({ occurredAt: null, flags: ['행위자 미검증', '기관 미확정'] });
    expect(emrAuditNote({ targetType: 'emr', extra: null })).toEqual({ occurredAt: null, flags: [] });
    expect(emrAuditNote({ targetType: 'patient', extra: { legacy_shell: true } })).toBeNull();
    expect(EMR_AUDIT_FLAG_LABELS.map(([, label]) => label)).toEqual(['옛 설치본', '행위자 불확실', '행위자 미검증', '몰아서 전송', '기관 미확정']);
  });

  it('같은 PC 행 수와 장치 작업 실패 문구', () => {
    expect([...devicesPerPc([{ keyPrefix: 'aa' }, { keyPrefix: 'bb' }, { keyPrefix: 'aa' }, { keyPrefix: null }])]).toEqual([['aa', 2], ['bb', 1]]);
    expect(deviceActionErrorMessage({ message: 'x', data: { code: 'DEVICE_PC_REVOKED' } })).toMatch(/해지되어 다시 승인할 수 없습니다/);
    expect(deviceActionErrorMessage({ message: 'server says', data: { code: 'OTHER' } })).toBe('server says');
  });
});

describe('AdminConsoleModal', () => {
  it('감사 로그 표에 비고 열 — EMR 기록의 발생 시각과 표시', async () => {
    vi.mocked(requestJson).mockImplementation(async (path) => {
      if (path.startsWith('/api/admin/audit')) {
        return {
          total: 3,
          items: [
            auditItem({ action: 'emr_inject', extra: { occurred_at: '2026-11-24T00:30:00.000Z', actor_source: 'session' } }),
            auditItem({ extra: { legacy_shell: true, occurred_at_unknown: true, actor_uncertain: true, burst: true } }),
            auditItem({ action: 'patient_view', targetType: 'patient', extra: { legacy_shell: true } }),
          ],
        };
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<AdminConsoleModal session={SESSION} onClose={() => {}} />);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: '비고' })).toBeTruthy();
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    const [, first, second, third] = within(table).getAllByRole('row');
    expect(within(first).getByText(/^발생 /)).toBeTruthy();
    expect(within(first).queryByText('옛 설치본')).toBeNull();
    for (const label of ['옛 설치본', '행위자 불확실', '몰아서 전송']) expect(within(second).getByText(label)).toBeTruthy();
    expect(within(second).queryByText(/^발생 /)).toBeNull();
    expect(within(third).queryByText('옛 설치본')).toBeNull(); // EMR이 아닌 기록에는 비고가 없다
  });

  it('장치 탭: PC(지문 앞자리) 열과 같은 PC 행 수, 해지된 PC 승인 실패 문구', async () => {
    const device = (over) => ({
      id: crypto.randomUUID(), userId: 'u', userName: '의사', userLoginId: 'doc', organizationId: 'org-1', buildTarget: 'intranet',
      status: 'active', registeredAt: '2026-11-01T00:00:00.000Z', lastSeenAt: null, registerIp: '10.0.0.5', suspicious: false, keyPrefix: 'a1b2c3d4', ...over,
    });
    const pending = device({ status: 'pending', userName: '간호사' });
    vi.mocked(requestJson).mockImplementation(async (path, options) => {
      if (path.startsWith('/api/admin/audit')) return { total: 0, items: [] };
      if (path === '/api/admin/devices') return { devices: [device({}), pending, device({ keyPrefix: 'ffff0000', userName: '다른 PC' })] };
      if (path === `/api/admin/devices/${pending.id}/approve` && options?.method === 'POST') {
        throw Object.assign(new Error('This PC has been revoked'), { status: 409, data: { code: 'DEVICE_PC_REVOKED' } });
      }
      throw new Error(`unexpected ${path}`);
    });
    render(<AdminConsoleModal session={SESSION} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '디바이스' }));
    const table = await screen.findByRole('table');
    await waitFor(() => expect(within(table).getAllByRole('row')).toHaveLength(4));
    expect(within(table).getByRole('columnheader', { name: 'PC' })).toBeTruthy();
    expect(within(table).getAllByText('a1b2c3d4')).toHaveLength(2);
    expect(within(table).getAllByText('같은 PC 2행')).toHaveLength(2);
    expect(within(table).getByText('ffff0000')).toBeTruthy();
    fireEvent.click(within(table).getByRole('button', { name: '승인' }));
    expect(await screen.findByText(/해지되어 다시 승인할 수 없습니다/)).toBeTruthy();
  });
});
