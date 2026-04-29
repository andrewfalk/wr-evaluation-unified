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
      serverTime:           new Date().toISOString(),
    });
  });

  return router;
}
