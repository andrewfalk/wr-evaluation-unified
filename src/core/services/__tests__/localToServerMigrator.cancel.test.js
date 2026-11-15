// 로컬→서버 이관 취소(계정 전환 수정 AS-4) — 기존 프리셋 조회를 기다리는 사이 화면이 내려가면 프리셋을 올리지 않는다.
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../presetRepository', async () => {
  const actual = await vi.importActual('../presetRepository');
  return { ...actual, fetchServerPresets: vi.fn(), createServerPreset: vi.fn(async () => ({})) };
});

import { fetchServerPresets, createServerPreset } from '../presetRepository';
import { migratePresetsToServer, MigrationCanceledError } from '../localToServerMigrator';

const session = { mode: 'intranet', apiBaseUrl: 'https://srv', accessToken: 't', user: { id: 'u', organizationId: 'o' } };
const presets = [{ jobName: '직종1', modules: {} }];

beforeEach(() => { vi.clearAllMocks(); });

describe('migratePresetsToServer — shouldProceed', () => {
  it('조회를 기다리는 사이 false가 되면 올리지 않고 취소로 끝낸다', async () => {
    let alive = true;
    fetchServerPresets.mockImplementation(async () => { alive = false; return []; });
    await expect(migratePresetsToServer(presets, { session, shouldProceed: () => alive })).rejects.toBeInstanceOf(MigrationCanceledError);
    expect(createServerPreset).not.toHaveBeenCalled();
  });

  it('주지 않으면 예전처럼 올린다', async () => {
    fetchServerPresets.mockResolvedValue([]);
    await expect(migratePresetsToServer(presets, { session })).resolves.toMatchObject({ migrated: 1 });
    expect(createServerPreset).toHaveBeenCalledTimes(1);
  });
});
