// 작업대의 집계 CSV 내보내기 — P2-77c에서 StatisticsWorkbench 본체의 상태·핸들러를 본문 그대로 옮겼다.
// 화면 생존 여부(mountedRef)는 본체의 ref를 그대로 받는다(실행 경로와 같이 쓴다).
import { useState } from 'react';
import type { MutableRefObject } from 'react';
import type { AnalyzeResponse } from '@wr/contracts/stats';
import { exportStatsAggregate } from '../../services/statsRepository';
import { downloadBlob, isFeatureUnavailableError } from './workbenchIo';

export interface StatsExportInput {
  committedResult: AnalyzeResponse | null;
  actionsLocked: boolean;
  exportUnsupported: boolean;
  session: unknown;
  mountedRef: MutableRefObject<boolean>;
  onFeatureUnavailable: () => void;
}

export function useStatsExport({
  committedResult, actionsLocked, exportUnsupported, session, mountedRef, onFeatureUnavailable,
}: StatsExportInput): { exportState: { status: string; error: unknown }; handleExport: () => Promise<void> } {
  const [exportState, setExportState] = useState<{ status: string; error: unknown }>({ status: 'idle', error: null });
  async function handleExport() {
    if (!committedResult || actionsLocked || exportUnsupported) return; // 버튼 disabled와 별개로 핸들러 자체도 잠금을 지킨다
    setExportState({ status: 'exporting', error: null });
    try {
      const blob = await exportStatsAggregate(committedResult.runManifest.analysisRunId, session);
      // 받는 동안 화면이 내려갔으면(계정 전환 등) 이전 화면의 내보내기 파일을 만들지 않는다(AS-4).
      if (!mountedRef.current) return;
      downloadBlob(blob, `stats-export-${committedResult.runManifest.analysisRunId}.csv`);
      setExportState({ status: 'idle', error: null });
    } catch (err) {
      if (isFeatureUnavailableError(err)) onFeatureUnavailable();
      setExportState({ status: 'error', error: err });
    }
  }

  return { exportState, handleExport };
}
