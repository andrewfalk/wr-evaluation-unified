// PR2 §9 — 통계분석 워크벤치 화면이 쓰는 서버 API 클라이언트. httpClient.js의 requestJson/
// requestBlobPost(인증·CSRF·401 재시도 이미 구현됨)을 그대로 재사용하고, 응답은 서버와
// 동일한 @wr/contracts zod 스키마로 실제 safeParse한다 — 타입 import만으로는 런타임
// 검증이 안 되므로, 서버 계약이 드리프트하면 여기서 조기에 잡는다(계획서 §9).
import {
  CatalogResponseSchema,
  PreviewResponseSchema,
  AnalyzeResponseSchema,
  AnalyzeAcceptedResponseSchema,
  RunStatusResponseSchema,
} from '@contracts/stats';
import { z } from 'zod';
import { requestJson, requestBlobPost } from './httpClient';

// PR4-B1 — POST /analyze는 syncBudgetMs 안에 못 끝나면 202(AnalyzeAcceptedResponseSchema)를
// 돌려준다 — 200/202 둘 다 requestJson 기준 "성공"(response.ok, 200~299)이라 throw되지
// 않는다. 어느 쪽인지는 body shape로 구분한다.
const AnalyzeOrAcceptedResponseSchema = z.union([AnalyzeResponseSchema, AnalyzeAcceptedResponseSchema]);

function parseOrThrow(schema, data, label) {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    const err = new Error(`통계 API 응답이 계약과 다릅니다(${label})`);
    err.zodIssues = parsed.error.issues;
    throw err;
  }
  return parsed.data;
}

export async function fetchStatsCatalog(session, { signal } = {}) {
  const data = await requestJson('/api/stats/catalog', {
    session,
    baseUrl: session?.apiBaseUrl,
    signal,
  });
  return parseOrThrow(CatalogResponseSchema, data, 'GET /catalog');
}

export async function previewStatsAnalysis(recipe, session, { signal } = {}) {
  const data = await requestJson('/api/stats/preview', {
    method: 'POST',
    session,
    baseUrl: session?.apiBaseUrl,
    body: recipe,
    signal,
  });
  return parseOrThrow(PreviewResponseSchema, data, 'POST /preview');
}

export async function runStatsAnalysis(recipe, session, { signal } = {}) {
  const data = await requestJson('/api/stats/analyze', {
    method: 'POST',
    session,
    baseUrl: session?.apiBaseUrl,
    body: recipe,
    signal,
  });
  return parseOrThrow(AnalyzeOrAcceptedResponseSchema, data, 'POST /analyze');
}

// PR4-B1 — §B 폴링. analysisRunId로 진행 상태/결과를 조회한다(DB id PK가 아님 —
// 기존 exportStatsAggregate의 analysisRunId 관례와 동일).
export async function getStatsRun(analysisRunId, session, { signal } = {}) {
  const data = await requestJson(`/api/stats/runs/${encodeURIComponent(analysisRunId)}`, {
    session,
    baseUrl: session?.apiBaseUrl,
    signal,
  });
  return parseOrThrow(RunStatusResponseSchema, data, 'GET /runs/:analysisRunId');
}

// PR4-B1 §E — 취소 의도 확정. 성공/멱등 성공만 이 함수가 정상 반환하고, 404/409는
// requestJson이 던지는 기존 관례를 그대로 따른다(호출부가 err.status로 분기).
export async function cancelStatsRun(analysisRunId, session, { signal } = {}) {
  return requestJson(`/api/stats/runs/${encodeURIComponent(analysisRunId)}/cancel`, {
    method: 'POST',
    session,
    baseUrl: session?.apiBaseUrl,
    signal,
  });
}

// CSV Blob 반환 — 성공 응답은 JSON이 아니므로 requestBlobPost를 쓴다(§9). 서버가 이미
// stats_runs에 저장된 결과를 그대로 포맷할 뿐이므로 recipe가 아니라 analysisRunId만 보낸다.
export async function exportStatsAggregate(analysisRunId, session, { signal } = {}) {
  return requestBlobPost('/api/stats/export', {
    session,
    baseUrl: session?.apiBaseUrl,
    body: { analysisRunId },
    signal,
  });
}
