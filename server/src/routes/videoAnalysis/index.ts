// Video analysis router: feature gate, auth and the route table.
// Split out of routes/videoAnalysis.ts (S5 P1-30); handler bodies unchanged.
import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import config from '../../config';
import { createAuthMiddleware } from '../../middleware/auth';
import { csrfMiddleware } from '../../middleware/csrf';
import { buildUploadMiddleware } from '../../workers/videoUpload';
import { asyncHandler } from '../../http/asyncHandler';
import { requireLockToken } from '../../http/lockToken';
import { requireFeature, requireOrg } from '../../http/authz';
import { createClip, sampleDetect, selectTarget, getSampleFrame } from './clips';
import { uploadClip } from './upload';
import { createJob, getJob, getOverlay, getOverlayFrame, closeReview } from './jobs';
import { applyJob } from './apply';

// ---------------------------------------------------------------------------
// 작업 영상 인간공학 분석 — clip/job 라이프사이클 + apply(영속화) API (6.0-4, mock).
//
// M1(mock) 범위: 서버는 clip/job 상태머신·권한·audit·apply 멱등 영속화를 담당한다.
// feature 계산 자체는 클라이언트(generateMockFeatures)에서 수행하며, 적용 시 클라가
// 계산한 환자 data를 apply 엔드포인트로 보내 If-Match 동시성으로 저장한다.
// 실제 추론(서버측 feature 계산)은 M2(6.0-5/6.0-6)에서 이 셸에 끼워 넣는다.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------
export function createVideoAnalysisRouter(pool: Pool): Router {
  const router = Router();
  const auth = createAuthMiddleware(pool);


  // Rejections go to the central error handler (http/errorHandler.ts, S1) — answered and logged there.
  const wrap = (fn: (p: Pool, req: Request, res: Response) => Promise<void>) =>
    asyncHandler((req: Request, res: Response) => fn(pool, req, res));

  // 피처플래그 fail-closed: 비활성 시 전 라우트 404(존재 누설 방지, PATIENT_NOT_FOUND 관례 일치).
  router.use(requireFeature(() => config.videoAnalysisEnabled));

  router.post('/clips', auth, csrfMiddleware, requireOrg(), wrap(createClip));
  // 실 영상 업로드(M3-7a). uploadDir 미설정 시 라우트 비활성(UPLOAD_DISABLED).
  const uploadMw = buildUploadMiddleware();
  if (uploadMw) {
    router.post('/clips/:clipId/upload', auth, csrfMiddleware, requireOrg(),
      asyncHandler((req: Request, res: Response) => uploadClip(pool, uploadMw, req, res)));
  } else {
    // No requireOrg(): the disabled-upload stub answers 503 for every session, as before.
    router.post('/clips/:clipId/upload', auth, csrfMiddleware,
      (_req: Request, res: Response) => res.status(503).json({ code: 'UPLOAD_DISABLED', error: 'video upload is not configured on this server' }));
  }
  router.post('/clips/:clipId/sample-detect', auth, csrfMiddleware, requireOrg(), wrap(sampleDetect));
  router.get('/clips/:clipId/sample-frame', auth, requireOrg(), wrap(getSampleFrame));
  router.post('/clips/:clipId/select-target', auth, csrfMiddleware, requireOrg(), wrap(selectTarget));
  router.post('/jobs', auth, csrfMiddleware, requireOrg(), wrap(createJob));
  router.get('/jobs/:jobId', auth, requireOrg(), wrap(getJob));
  router.get('/jobs/:jobId/overlay', auth, requireOrg(), wrap(getOverlay));
  router.get('/jobs/:jobId/overlay-frame/:frameIndex', auth, requireOrg(), wrap(getOverlayFrame));
  router.post('/jobs/:jobId/apply', auth, csrfMiddleware, requireOrg(), requireLockToken(), wrap(applyJob));
  router.post('/jobs/:jobId/close-review', auth, csrfMiddleware, requireOrg(), wrap(closeReview));

  return router;
}
