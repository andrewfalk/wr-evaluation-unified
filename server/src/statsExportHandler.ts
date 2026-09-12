// PR2 §7 — POST /export. 계획서(pr2-dreamy-frog.md) §7의 최종 설계: aggregate export는
// recipe를 다시 받지 않는다 — `stats_runs`에 이미 억제 적용 후 저장된 manifest/result를
// analysisRunId 하나로 조회해 그대로 CSV로 포맷할 뿐이다(재계산·재snapshot 없음).
//
// 접근 규칙(§7 [필수 수정 2]): 조직 일치만 확인하고 requester 소유권은 보지 않는다 —
// stats_runs의 성공 캐시는 (organization_id, execution_digest)로만 조직 전체가 공유하므로,
// "요청자 본인만 export"를 걸면 캐시 히트로 같은 결과를 화면에서 본 다른 사용자가 자기
// 눈으로 본 결과를 못 내보내는 모순이 생긴다. capability(stats.export_results)는 그대로
// 유지한다 — 이번 결정은 "누가 실행했는지"만 export 조건에서 빼는 것이다.
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import {
  ExportAggregateRequestSchema,
  RunManifestSchema,
  AnalyzeResultSchema,
  type AnalyzeResult,
  type RunManifest,
  type AnalyzeContinuousResult,
  type AnalyzeDiscreteResult,
  type AnalyzeMissingPatternEntry,
} from '@wr/contracts';
import { writeAuditLogStrict, type AuditOutcome } from './middleware/audit';

interface StatsRunRow {
  manifest: unknown;
  result: unknown;
  status: string;
  requested_disclosure_profile: string;
  expires_at: string;
}

// CSV formula injection 방어(§7.5) — 문자열 셀만 대상. 숫자 통계값(음수 포함)은 이스케이프
// 대상이 아니다 — 문자열로 감싸면 엑셀에서 숫자가 아니라 텍스트로 깨진다.
function escapeCsvString(value: string): string {
  const needsFormulaEscape = /^[=+\-@]/.test(value);
  const escaped = needsFormulaEscape ? `'${value}` : value;
  if (/[",\n\r]/.test(escaped)) {
    return `"${escaped.replace(/"/g, '""')}"`;
  }
  return escaped;
}

function csvNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function csvString(value: string | boolean | null): string {
  if (value === null) return '';
  return escapeCsvString(String(value));
}

function missingPatternsCell(value: AnalyzeMissingPatternEntry[] | null): string {
  if (value === null) return escapeCsvString('(비공개)'); // §8 — null(억제)과 []([]  0건)을 다른 표기로 구분
  if (value.length === 0) return escapeCsvString('(없음)');
  return escapeCsvString(value.map((p) => `${p.reasonCode}:${p.count}`).join('; '));
}

function buildCsv(manifest: RunManifest, result: AnalyzeResult): string {
  const lines: string[] = [];
  // 메타 헤더 — §1.2 provenance 요구. run 식별자·버전이 CSV에 남아야 나중에 대조 가능하다.
  lines.push(`# analysisRunId,${manifest.analysisRunId}`);
  lines.push(`# snapshotAsOf,${manifest.snapshotAsOf}`);
  lines.push(`# catalogVersion,${manifest.catalogVersion}`);
  lines.push(`# extractorVersion,${manifest.extractorVersion}`);
  lines.push(`# migrationVersion,${manifest.migrationVersion}`);
  lines.push(`# engineVersion,${manifest.engineVersion}`);
  lines.push(`# serializerVersion,${manifest.serializerVersion}`);
  lines.push(`# estimabilityPolicyVersion,${manifest.estimabilityPolicyVersion}`);
  lines.push(`# note,원본 DB 변경 후 exact rerun은 보장되지 않음 — provenance/무결성 검증용(계획서 §1.2)`);
  lines.push('');

  lines.push(['section', 'variableKey', 'suppressed', 'n', 'missingCount', 'missingPatterns',
    'mean', 'sd', 'median', 'q1', 'q3', 'iqr', 'skewness', 'kurtosis', 'min', 'max',
    'level', 'levelCount', 'levelProportion', 'mode'].join(','));

  for (const row of result.continuous as AnalyzeContinuousResult[]) {
    if (row.suppressed) {
      lines.push(['continuous', csvString(row.variableKey), 'true', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
      continue;
    }
    lines.push([
      'continuous', csvString(row.variableKey), 'false',
      csvNumber(row.n), csvNumber(row.missingCount), missingPatternsCell(row.missingPatterns),
      csvNumber(row.mean), csvNumber(row.sd), csvNumber(row.median), csvNumber(row.q1), csvNumber(row.q3),
      csvNumber(row.iqr), csvNumber(row.skewness), csvNumber(row.kurtosis), csvNumber(row.min), csvNumber(row.max),
      '', '', '', '',
    ].join(','));
  }

  for (const row of result.discrete as AnalyzeDiscreteResult[]) {
    if (row.suppressed) {
      lines.push(['discrete', csvString(row.variableKey), 'true', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''].join(','));
      continue;
    }
    if (row.levels.length === 0) {
      lines.push([
        'discrete', csvString(row.variableKey), 'false',
        csvNumber(row.n), csvNumber(row.missingCount), missingPatternsCell(row.missingPatterns),
        '', '', '', '', '', '', '', '', '', '',
        '', '', '', csvString(row.mode),
      ].join(','));
      continue;
    }
    for (const level of row.levels) {
      lines.push([
        'discrete', csvString(row.variableKey), 'false',
        csvNumber(row.n), csvNumber(row.missingCount), missingPatternsCell(row.missingPatterns),
        '', '', '', '', '', '', '', '', '', '',
        csvString(level.level), String(level.count), String(level.proportion), csvString(row.mode),
      ].join(','));
    }
  }

  // 엑셀 한글 호환 — UTF-8 BOM.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export async function handlePostExport(pool: Pool, req: Request, res: Response): Promise<void> {
  const parsed = ExportAggregateRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ code: 'INVALID_REQUEST', errors: parsed.error.issues });
    return;
  }
  const { analysisRunId } = parsed.data;

  const session = req.sessionInfo!;
  const orgId = session.organizationId!;
  const userId = session.userId;

  const found = await pool.query<StatsRunRow>(
    `SELECT manifest, result, status, requested_disclosure_profile, expires_at
       FROM stats_runs
      WHERE organization_id = $1 AND analysis_run_id = $2`,
    [orgId, analysisRunId],
  );

  const auditDenied = (reasonCode: string) =>
    writeAuditLogStrict(pool, {
      actorUserId: userId,
      actorOrgId: orgId,
      action: 'stats_export_aggregate',
      targetType: 'stats_run',
      targetId: analysisRunId,
      outcome: 'denied' as AuditOutcome,
      ip: req.ip ?? null,
      userAgent: req.headers['user-agent'] ?? null,
      extra: { analysisRunId, reasonCode },
    });

  if (found.rows.length === 0) {
    // cleanup job(statsRunCleanup.ts)이 만료 행을 이미 지웠거나 원래 없는 id — §4의
    // "기능 자체가 꺼짐"(NOT_FOUND, 미들웨어가 던짐)과는 다른 코드라 클라이언트가 구분한다.
    await auditDenied('RUN_NOT_FOUND');
    res.status(404).json({ code: 'RUN_NOT_FOUND', error: '분석 결과를 찾을 수 없습니다.' });
    return;
  }
  const row = found.rows[0];

  if (row.status !== 'succeeded') {
    await auditDenied('RUN_NOT_SUCCEEDED');
    res.status(409).json({ code: 'RUN_NOT_SUCCEEDED', error: '실패한 실행은 내보낼 수 없습니다.' });
    return;
  }

  if (row.requested_disclosure_profile !== 'aggregate') {
    // 방어적 검사 — PR2에서는 항상 aggregate라 이론상 도달 불가. 미래 PR이 이 라우트를
    // limited_row/phi 등급에 잘못 재사용하면 여기서 잡힌다(§7).
    console.error('[stats-export] unexpected requested_disclosure_profile', {
      analysisRunId, profile: row.requested_disclosure_profile,
    });
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    return;
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    // 아직 cleanup job이 지우지 않은 만료 행 — 지워졌으면 위에서 이미 404로 빠진다.
    // 클라이언트는 404/410을 같은 안내로 처리하면 되고, 서버는 감사·로그 분석을 위해 구분한다.
    await auditDenied('RUN_EXPIRED');
    res.status(410).json({ code: 'RUN_EXPIRED', error: '결과가 만료되었습니다 — 다시 분석해 주세요.' });
    return;
  }

  const manifestParsed = RunManifestSchema.safeParse(row.manifest);
  const resultParsed = AnalyzeResultSchema.safeParse(row.result);
  if (!manifestParsed.success || !resultParsed.success) {
    console.error('[stats-export] stored manifest/result failed schema validation', {
      analysisRunId,
      manifestIssues: manifestParsed.success ? null : manifestParsed.error.issues,
      resultIssues: resultParsed.success ? null : resultParsed.error.issues,
    });
    res.status(500).json({ code: 'INTERNAL_ERROR', error: 'Internal server error' });
    return;
  }

  // PR3-A §"결과 계약 불변조건" — CSV export 거부는 result.bivariate 존재 여부가
  // 아니라 manifest.analysisMode 기준으로 판정한다(조기억제 경로 등 result.bivariate가
  // 없는 응답도 있을 수 있어 판정이 샐 수 있음 — manifest는 저장 시점에 항상 채워짐).
  // 구버전 저장 결과는 analysisMode 필드 자체가 없어(optional) undefined이고, 그
  // 경우는 기존 동작 그대로 descriptive로 취급해 export를 허용한다.
  if (manifestParsed.data.analysisMode === 'bivariate') {
    await auditDenied('BIVARIATE_EXPORT_NOT_SUPPORTED');
    res.status(400).json({ code: 'BIVARIATE_EXPORT_NOT_SUPPORTED', error: '이변량 분석 결과는 아직 CSV 내보내기를 지원하지 않습니다.' });
    return;
  }
  // PR3-B — 상관행렬도 CSV export 미지원(PR5 범위). 위와 동일한 판정 축(manifest.
  // analysisMode)을 재사용한다.
  if (manifestParsed.data.analysisMode === 'correlation_matrix') {
    await auditDenied('CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED');
    res.status(400).json({ code: 'CORRELATION_MATRIX_EXPORT_NOT_SUPPORTED', error: '상관행렬 분석 결과는 아직 CSV 내보내기를 지원하지 않습니다.' });
    return;
  }

  const csv = buildCsv(manifestParsed.data, resultParsed.data);

  // §7.4 원칙을 aggregate 등급에도 적용 — 감사 INSERT가 실패하면 CSV는 한 바이트도 안 나간다.
  await writeAuditLogStrict(pool, {
    actorUserId: userId,
    actorOrgId: orgId,
    action: 'stats_export_aggregate',
    targetType: 'stats_run',
    targetId: analysisRunId,
    outcome: 'success' as AuditOutcome,
    ip: req.ip ?? null,
    userAgent: req.headers['user-agent'] ?? null,
    extra: { analysisRunId, recipeDigest: manifestParsed.data.recipeDigest, sourceDigest: manifestParsed.data.sourceDigest },
  });

  res.status(200)
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="stats-export-${analysisRunId}.csv"`)
    .send(csv);
}
