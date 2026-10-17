import { Router, type Request, type Response } from 'express';
import config from '../config';
import { getStatsWorkbenchAvailability } from '../statsWorkbenchRuntimeState';

export function createConfigRouter(): Router {
  const router = Router();

  router.get('/public', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      mode:                 config.deploymentMode,
      aiEnabled:            config.ai.enabled,
      // 현행 보고서 전문(fullReport)을 서버로 보내도 되는지. 병원 내부 LLM일 때만 true — 외부 벤더 경로는
      // 서버 스키마가 fullReport를 거부하므로 클라이언트가 보내지 않게 알려 준다. boolean 하나만 공개한다.
      aiFullReportAllowed:  config.ai.enabled && config.ai.provider === 'internal',
      localFallbackAllowed: config.localFallbackAllowed,
      videoAnalysisEnabled: config.videoAnalysisEnabled,
      // dev-only fixture 입력 UI 노출용 플래그만 공개. fixtureDir 등 서버 경로는 절대 노출하지 않는다.
      videoAnalysisFixtureMode: config.video.fixtureMode,
      // 6.0-12: 클라이언트 폴링 상한을 서버 deadline에서 파생시키기 위한 공개 값(ms). 경로/비밀 아님.
      videoAnalysisJobDeadlineMs: config.video.jobDeadlineMs,
      videoAnalysisQueueWaitMs:   config.video.queueWaitMs,
      // PR0-A: 통계 워크벤치 노출 플래그만 공개(boolean만 — 비활성 사유 문자열은
      // 내부 인프라 상태를 드러낼 수 있어 노출하지 않는다).
      statsWorkbenchEnabled:      config.statsWorkbenchEnabled,
      statsWorkbenchAvailable:    getStatsWorkbenchAvailability().available,
      serverTime:           new Date().toISOString(),
    });
  });

  return router;
}
