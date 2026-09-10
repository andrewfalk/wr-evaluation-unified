// PR2 §9 — 통계분석 워크벤치 화면이 쓰는 서버 API 클라이언트. httpClient.js의 requestJson/
// requestBlobPost(인증·CSRF·401 재시도 이미 구현됨)을 그대로 재사용하고, 응답은 서버와
// 동일한 @wr/contracts zod 스키마로 실제 safeParse한다 — 타입 import만으로는 런타임
// 검증이 안 되므로, 서버 계약이 드리프트하면 여기서 조기에 잡는다(계획서 §9).
import {
  CatalogResponseSchema,
  PreviewResponseSchema,
  AnalyzeResponseSchema,
} from '@contracts/stats';
import { requestJson, requestBlobPost } from './httpClient';

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
  return parseOrThrow(AnalyzeResponseSchema, data, 'POST /analyze');
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
