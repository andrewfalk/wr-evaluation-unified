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

// §1.2 provenance 요구 — run 식별자·버전이 CSV에 남아야 나중에 대조 가능하다.
// buildCsv/buildRegressionCsv 둘 다 쓴다(PR4-A2에서 공용 추출).
function buildMetaHeaderLines(manifest: RunManifest): string[] {
  return [
    `# analysisRunId,${manifest.analysisRunId}`,
    `# snapshotAsOf,${manifest.snapshotAsOf}`,
    `# catalogVersion,${manifest.catalogVersion}`,
    `# extractorVersion,${manifest.extractorVersion}`,
    `# migrationVersion,${manifest.migrationVersion}`,
    `# engineVersion,${manifest.engineVersion}`,
    `# serializerVersion,${manifest.serializerVersion}`,
    `# estimabilityPolicyVersion,${manifest.estimabilityPolicyVersion}`,
    `# note,원본 DB 변경 후 exact rerun은 보장되지 않음 — provenance/무결성 검증용(계획서 §1.2)`,
    '',
  ];
}

function buildCsv(manifest: RunManifest, result: AnalyzeResult): string {
  const lines: string[] = buildMetaHeaderLines(manifest);

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

// PR4-A2 — 회귀 결과 CSV export(계획서 §4 "그 외 배선" — regression 차단 제거).
// 계수·적합도·VIF·condition number·spline 곡선점만 담는다 — **pointDiagnostics는
// 절대 넣지 않는다**(limited_row 등급이라 이 aggregate-only(stats.export_results)
// 엔드포인트 범위 밖 — 행단위 export는 PR5가 아직 없다).
function buildRegressionCsv(manifest: RunManifest, result: AnalyzeResult): string {
  const lines: string[] = buildMetaHeaderLines(manifest);
  const regression = result.regression;

  if (!regression || regression.suppressed) {
    lines.push('# section,suppressed');
    lines.push(['reasonCode'].join(','));
    lines.push([csvString(regression?.suppressed ? regression.reasonCode : null)].join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  lines.push(`# estimation,${regression.estimation}`);
  if (regression.nonEstimableReason) lines.push(`# nonEstimableReason,${regression.nonEstimableReason}`);
  if (regression.inferenceWithheldReason) lines.push(`# inferenceWithheldReason,${regression.inferenceWithheldReason}`);
  lines.push('');

  // PR4-A2(리뷰 후 추가) — eventLevel·기준 범주·표준화 여부는 계수/OR의 해석을
  // 바꾸는 정보인데도 CSV엔 계수만 있어 다운로드한 파일만으로는 해석이 불가능했다
  // (리뷰 지적). 모형 메타데이터 섹션을 추가한다.
  lines.push('# section,model');
  lines.push(['outcomeKey', 'eventLevel', 'method', 'covariance'].join(','));
  lines.push([
    csvString(regression.outcomeKey), csvString(regression.eventLevel), csvString(regression.method),
    csvString(regression.covariance),
  ].join(','));
  lines.push('');

  lines.push('# section,referenceLevelsUsed');
  lines.push(['variableKey', 'referenceLevel'].join(','));
  for (const [key, level] of Object.entries(regression.referenceLevelsUsed)) {
    lines.push([csvString(key), csvString(level)].join(','));
  }
  lines.push('');

  lines.push('# section,standardization');
  lines.push(['variableKey', 'mean', 'sd'].join(','));
  for (const key of regression.standardizedPredictorKeys) {
    const stats = regression.standardization?.[key] ?? null;
    lines.push([csvString(key), csvNumber(stats?.mean ?? null), csvNumber(stats?.sd ?? null)].join(','));
  }
  lines.push('');

  lines.push('# section,coefficients');
  lines.push([
    'name', 'label', 'variableKey', 'level', 'termType', 'estimate', 'se', 'statistic',
    'pValue', 'ciLower', 'ciUpper', 'orEstimate', 'orCiLower', 'orCiUpper',
  ].join(','));
  for (const term of regression.terms) {
    lines.push([
      csvString(term.name), csvString(term.label), csvString(term.variableKey), csvString(term.level),
      csvString(term.termType), csvNumber(term.estimate), csvNumber(term.se), csvNumber(term.statistic),
      csvNumber(term.pValue), csvNumber(term.ciLower), csvNumber(term.ciUpper),
      csvNumber(term.exponentiated?.estimate ?? null), csvNumber(term.exponentiated?.ciLower ?? null),
      csvNumber(term.exponentiated?.ciUpper ?? null),
    ].join(','));
  }
  lines.push('');

  lines.push('# section,fit');
  lines.push(['method', 'n', 'personCount', 'residualDf', 'r2', 'adjR2', 'logLik', 'aic', 'pseudoR2'].join(','));
  lines.push([
    csvString(regression.method), csvNumber(regression.n), csvNumber(regression.personCount),
    csvNumber(regression.residualDf), csvNumber(regression.fit?.r2 ?? null), csvNumber(regression.fit?.adjR2 ?? null),
    csvNumber(regression.fit?.logLik ?? null), csvNumber(regression.fit?.aic ?? null),
    csvNumber(regression.fit?.pseudoR2 ?? null),
  ].join(','));
  lines.push('');

  if (regression.diagnostics) {
    lines.push('# section,diagnostics');
    lines.push(['conditionNumber'].join(','));
    lines.push([csvNumber(regression.diagnostics.conditionNumber)].join(','));
    lines.push('');
    lines.push(['variableKey', 'termName', 'vif'].join(','));
    for (const v of regression.diagnostics.vif ?? []) {
      lines.push([csvString(v.variableKey), csvString(v.termName), csvNumber(v.vif)].join(','));
    }
    lines.push('');
  }

  if (regression.splinePartialEffects) {
    lines.push('# section,splinePartialEffects');
    lines.push([
      'variableKey', 'x', 'deltaFromBaseline', 'ciLower', 'ciUpper', 'orEstimate', 'orCiLower', 'orCiUpper',
    ].join(','));
    for (const effect of regression.splinePartialEffects) {
      for (const point of effect.points) {
        lines.push([
          csvString(effect.variableKey), csvNumber(point.x), csvNumber(point.deltaFromBaseline),
          csvNumber(point.ciLower), csvNumber(point.ciUpper),
          csvNumber(point.exponentiated?.estimate ?? null), csvNumber(point.exponentiated?.ciLower ?? null),
          csvNumber(point.exponentiated?.ciUpper ?? null),
        ].join(','));
      }
    }
  }

  // 엑셀 한글 호환 — UTF-8 BOM.
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// PR4-B2 — 예측 결과 CSV export(계획서 §5단계 "집계 성능 CSV — 계수는 제외").
// coefficients는 이 aggregate-only 엔드포인트에 의도적으로 담지 않는다 — 계획서가
// 명시적으로 "계수는 제외"라고 못박았다(연구용 내부검증 지표만 내보내는 것이
// 목적이지, 모형을 재구성할 수 있는 값까지 내보내는 것이 목적이 아님).
function buildPredictionCsv(manifest: RunManifest, result: AnalyzeResult): string {
  const lines: string[] = buildMetaHeaderLines(manifest);
  const prediction = result.prediction;

  if (!prediction || prediction.suppressed) {
    lines.push('# section,suppressed');
    lines.push(['reasonCode'].join(','));
    lines.push([csvString(prediction?.suppressed ? prediction.reasonCode : null)].join(','));
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  lines.push(`# estimation,${prediction.estimation}`);
  if (prediction.nonEstimableReason) lines.push(`# nonEstimableReason,${prediction.nonEstimableReason}`);
  lines.push('');

  lines.push('# section,model');
  lines.push(['outcomeKey', 'eventLevel', 'method', 'n', 'personCount', 'eventPersonCount',
    'nonEventPersonCount', 'prevalence', 'excludedRowCount', 'parameterCount', 'columnCount',
    'droppedColumnFoldCount'].join(','));
  lines.push([
    csvString(prediction.outcomeKey), csvString(prediction.eventLevel), csvString(prediction.method),
    csvNumber(prediction.n), csvNumber(prediction.personCount), csvNumber(prediction.eventPersonCount),
    csvNumber(prediction.nonEventPersonCount), csvNumber(prediction.prevalence), csvNumber(prediction.excludedRowCount),
    csvNumber(prediction.parameterCount), csvNumber(prediction.columnCount), csvNumber(prediction.droppedColumnFoldCount),
  ].join(','));
  lines.push('');

  lines.push('# section,validation');
  lines.push(['scheme', 'outerFolds', 'repeats', 'innerFolds', 'outerFoldBasis', 'samplerVersion'].join(','));
  lines.push([
    csvString(prediction.validation.scheme), csvNumber(prediction.validation.outerFolds),
    csvNumber(prediction.validation.repeats), csvNumber(prediction.validation.innerFolds),
    csvString(prediction.validation.outerFoldBasis), csvString(prediction.validation.samplerVersion),
  ].join(','));
  lines.push('');

  lines.push('# section,lambda');
  lines.push(['selected', 'gridMin', 'gridMax', 'gridSize'].join(','));
  lines.push([
    csvNumber(prediction.lambda.selected), csvNumber(prediction.lambda.gridMin),
    csvNumber(prediction.lambda.gridMax), csvNumber(prediction.lambda.gridSize),
  ].join(','));
  lines.push('');

  lines.push('# section,metrics');
  lines.push([
    'metric', 'apparent', 'representativeRepeat',
    'cvStatus', 'cvWithheldReason', 'cvValidRepeats', 'cvTotalRepeats', 'cvMean', 'cvMin', 'cvMax',
    'bootstrapStatus', 'bootstrapWithheldReason', 'bootstrapValidReplicates', 'bootstrapTotalReplicates',
    'bootstrapOptimism', 'bootstrapCorrected', 'bootstrapCorrectedOutOfRange',
  ].join(','));
  for (const m of prediction.metrics) {
    lines.push([
      csvString(m.metric), csvNumber(m.apparent), csvNumber(m.representativeRepeat),
      csvString(m.cv.status), csvString(m.cv.withheldReason), csvNumber(m.cv.validRepeats), csvNumber(m.cv.totalRepeats),
      csvNumber(m.cv.mean), csvNumber(m.cv.min), csvNumber(m.cv.max),
      csvString(m.bootstrap.status), csvString(m.bootstrap.withheldReason),
      csvNumber(m.bootstrap.validReplicates), csvNumber(m.bootstrap.totalReplicates),
      csvNumber(m.bootstrap.optimism), csvNumber(m.bootstrap.corrected),
      String(m.bootstrap.correctedOutOfRange),
    ].join(','));
  }
  lines.push('');

  lines.push('# section,aucCi');
  lines.push(['target', 'lower', 'upper', 'method', 'replicates'].join(','));
  if (prediction.aucCi) {
    lines.push([
      csvString(prediction.aucCi.target), csvNumber(prediction.aucCi.lower), csvNumber(prediction.aucCi.upper),
      csvString(prediction.aucCi.method), csvNumber(prediction.aucCi.replicates),
    ].join(','));
  }
  lines.push('');

  lines.push('# section,curves');
  lines.push(`# curvesSuppressedReason,${prediction.curves?.suppressedReason ?? ''}`);
  lines.push(['upperThreshold', 'rows', 'positiveRows', 'meanPredicted', 'observedRate'].join(','));
  for (const bin of prediction.curves?.bins ?? []) {
    lines.push([
      csvNumber(bin.upperThreshold), csvNumber(bin.rows), csvNumber(bin.positiveRows),
      csvNumber(bin.meanPredicted), csvNumber(bin.observedRate),
    ].join(','));
  }
  lines.push('');

  lines.push('# section,caveats');
  lines.push(['caveat'].join(','));
  for (const c of prediction.caveats) lines.push([csvString(c)].join(','));
  lines.push('');

  lines.push('# section,notPerformed');
  lines.push(['item'].join(','));
  for (const item of prediction.notPerformed) lines.push([csvString(item)].join(','));

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
  // PR4-A2 — 회귀 결과는 전용 CSV 빌더로 분기한다(pointDiagnostics는 절대 넣지
  // 않음 — buildRegressionCsv 주석 참고). PR4-B2 — 예측도 전용 빌더(계수 제외 —
  // buildPredictionCsv 주석 참고).
  const csv = manifestParsed.data.analysisMode === 'regression'
    ? buildRegressionCsv(manifestParsed.data, resultParsed.data)
    : manifestParsed.data.analysisMode === 'prediction'
      ? buildPredictionCsv(manifestParsed.data, resultParsed.data)
      : buildCsv(manifestParsed.data, resultParsed.data);

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
