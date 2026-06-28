import { Router, type Request, type Response } from 'express';
import config from '../config';

export function createConfigRouter(): Router {
  const router = Router();

  router.get('/public', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      mode:                 config.deploymentMode,
      aiEnabled:            config.ai.enabled,
      localFallbackAllowed: config.localFallbackAllowed,
      videoAnalysisEnabled: config.videoAnalysisEnabled,
      // dev-only fixture 입력 UI 노출용 플래그만 공개. fixtureDir 등 서버 경로는 절대 노출하지 않는다.
      videoAnalysisFixtureMode: config.video.fixtureMode,
      // 6.0-12: 클라이언트 폴링 상한을 서버 deadline에서 파생시키기 위한 공개 값(ms). 경로/비밀 아님.
      videoAnalysisJobDeadlineMs: config.video.jobDeadlineMs,
      videoAnalysisQueueWaitMs:   config.video.queueWaitMs,
      serverTime:           new Date().toISOString(),
    });
  });

  return router;
}
