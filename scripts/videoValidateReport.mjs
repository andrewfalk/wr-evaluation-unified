// 6.0-B2 Node 비교 하네스 — validate_set.py가 만든 bundle을 **앱과 동일한 변환 경로**로 처리해
// gold annotation과 비교하고 §8.9 오차 리포트를 낸다.
//
// 핵심: 변환 순서·로직을 재구현하지 않고 프로덕션 모듈을 그대로 로드한다(검증값 == 앱 출력).
//   - videoViewpointFusion.fuseClipFeatureSetsWithEvidence → videoPerDayConversion.convertClipFeaturesToPerDay
//     (= videoAnalysisRun과 동일한 "융합 먼저, per-day 1회" 순서).
//   - 비교 직전에만 검증 전용 normalization(candidate→비교가능)을 적용(앱 경로 불변).
//   - 오차 산식은 videoValidation.js single-source.
//
// 실행: node scripts/videoValidateReport.mjs --bundle <validation_bundle.json>
//          --annotations <annotations.json> [--out report.json]
//   사전: shared/dist 빌드 필요(@contracts alias) → package.json prevideo:validate-report가 prebuild-shared.mjs 실행.
//   @contracts alias(=shared/dist)는 Vite가 해석하므로 Vite SSR(ssrLoadModule)로 모듈을 로드한다(plain node 불가).

import fs from 'node:fs';
import { createServer } from 'vite';

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--annotations') out.annotations = argv[++i];
    else if (a === '--out') out.out = argv[++i];
  }
  if (!out.bundle || !out.annotations) {
    console.error('usage: node scripts/videoValidateReport.mjs --bundle <bundle.json> --annotations <ann.json> [--out report.json]');
    process.exit(2);
  }
  return out;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf-8'));
}

// activeModules → 그 모듈에 속한 featureKey만(앱의 requestedFeatures 필터 대응). 비면 전체 허용.
function allowedFeatureKeysFor(activeModules, VIDEO_FEATURE_TARGETS) {
  if (!activeModules || activeModules.length === 0) return undefined;
  const set = new Set(activeModules);
  return Object.keys(VIDEO_FEATURE_TARGETS).filter((k) => set.has(VIDEO_FEATURE_TARGETS[k].moduleId));
}

async function main() {
  const args = parseArgs(process.argv);
  const bundle = readJson(args.bundle);
  const annotationDoc = readJson(args.annotations);

  const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
  try {
    const fusion = await vite.ssrLoadModule('/src/core/services/videoViewpointFusion.js');
    const perDay = await vite.ssrLoadModule('/src/core/services/videoPerDayConversion.js');
    const validation = await vite.ssrLoadModule('/src/core/services/videoValidation.js');
    const vthresh = await vite.ssrLoadModule('/src/core/services/videoValidationThresholds.js');
    const contracts = await vite.ssrLoadModule('@contracts/index');

    const { VIDEO_FEATURE_TARGETS, AnnotationSetSchema } = contracts;

    // gold annotation 계약 검증(신뢰 경계) → id로 lookup.
    const annSet = AnnotationSetSchema.parse(annotationDoc);
    const goldById = new Map(annSet.annotations.map((a) => [a.id, a]));

    const comparisons = [];                 // videoValidation 비교결과 누적(여러 case)
    const riskPairsByFeature = {};          // featureKey → [{predicted, actual}]
    const skips = [];                       // 비교 제외 사유 집계(not_comparable 등)
    const caseReports = [];

    for (const c of bundle.cases || []) {
      const gold = goldById.get(c.annotationId);
      if (!gold) { skips.push({ caseId: c.caseId, reason: 'no_gold_for_case', annotationId: c.annotationId }); continue; }

      // 1) 시점 융합(앱과 동일) → 2) per-day 환산(1회).
      const entries = (c.clips || []).map((cl) => ({ viewpoint: cl.viewpoint, clipFeatureSet: cl.clipFeatures }));
      const { fused } = fusion.fuseClipFeatureSetsWithEvidence(entries);
      if (!fused) { skips.push({ caseId: c.caseId, reason: 'no_fused_features' }); continue; }
      const allowed = allowedFeatureKeysFor(c.activeModules, VIDEO_FEATURE_TARGETS);
      const conv = perDay.convertClipFeaturesToPerDay(fused, c.activeMinutesPerDay, { allowedFeatureKeys: allowed });

      // 3) 검증 전용 normalization(비교 직전, 앱 출력 불변): candidate→비교가능.
      const normalizedMap = {};
      const caseSkips = [];
      for (const [key, fv] of Object.entries(conv.features)) {
        const norm = vthresh.normalizeForComparison(key, fv, conv.evidenceByFeatureKey[key] || {});
        if (norm && norm.status) { caseSkips.push({ featureKey: key, reason: norm.status }); continue; }
        normalizedMap[key] = norm;
      }
      for (const s of caseSkips) skips.push({ caseId: c.caseId, ...s });

      // 4) gold와 비교(오차 산식 = videoValidation single-source).
      const caseComparisons = validation.compareFeatureMap(normalizedMap, gold.features);
      for (const cmp of caseComparisons) comparisons.push(cmp);

      // 5) 위험 역치 이진화 pair(sensitivity/specificity) — 추출·gold 모두 컷오프 적용 가능할 때만.
      for (const [key, norm] of Object.entries(normalizedMap)) {
        const predicted = vthresh.riskBinarize(key, norm);
        const goldVal = gold.features[key];
        const actual = goldVal ? vthresh.riskBinarize(key, { kind: goldVal.kind, value: goldVal.value, unit: goldVal.unit }) : null;
        if (predicted != null && actual != null) {
          (riskPairsByFeature[key] || (riskPairsByFeature[key] = [])).push({ predicted, actual });
        }
      }

      // 케이스별 결과(원인 귀속용): feature별 predicted/gold/error/status + 비교 제외 사유.
      caseReports.push({
        caseId: c.caseId,
        videoRef: c.videoRef,
        annotationId: c.annotationId,
        comparisons: caseComparisons,
        skips: caseSkips,
      });
    }

    // 집계 + §8.9 허용오차 판정.
    const summaries = validation.summarizeErrors(comparisons).map((s) => ({
      ...s,
      withinTolerance: validation.withinTolerance(s),
    }));
    const riskMetrics = Object.fromEntries(
      Object.entries(riskPairsByFeature).map(([k, pairs]) => [k, validation.binaryMetrics(pairs)])
    );

    const report = {
      generatedAt: new Date().toISOString(),
      tolerances: validation.EXAMPLE_TOLERANCES,
      caseCount: (bundle.cases || []).length,
      comparedCases: caseReports.length,
      summaries,
      riskMetrics,
      cases: caseReports, // 변수별 원인 귀속(어떤 영상/변수에서 왜 틀렸나)
      skips,
    };

    printTable(summaries, riskMetrics, skips);
    if (args.out) {
      fs.writeFileSync(args.out, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n[report] → ${args.out}`);
    }
  } finally {
    await vite.close();
  }
}

// §8.9 대비표 콘솔 출력.
function printTable(summaries, riskMetrics, skips) {
  console.log('\n=== 6.0-B2 검증 리포트 (§8.9) ===');
  console.log('\n[변수별 오차]');
  if (summaries.length === 0) console.log('  (비교된 numeric/bool/categorical 변수 없음)');
  for (const s of summaries) {
    if (s.kind === 'numeric') {
      const tol = s.withinTolerance == null ? '-' : (s.withinTolerance ? 'PASS' : 'FAIL');
      const err = s.metric === 'angle' ? `MAE=${s.mae.toFixed(2)}°` : `meanErrorRate=${(s.meanErrorRate * 100).toFixed(1)}%`;
      console.log(`  ${s.featureKey.padEnd(28)} n=${s.n} ${s.metric.padEnd(6)} ${err.padEnd(22)} 허용오차:${tol}`);
    } else {
      console.log(`  ${s.featureKey.padEnd(28)} n=${s.n} ${s.kind.padEnd(6)} agreement=${(s.agreement * 100).toFixed(1)}%`);
    }
  }
  console.log('\n[위험 역치 초과 여부]');
  const rk = Object.keys(riskMetrics);
  if (rk.length === 0) console.log('  (CANDIDATE_RISK_DECISION_THRESHOLDS 미선언 → sensitivity 계산 생략)');
  for (const [k, m] of Object.entries(riskMetrics)) {
    const sens = m.sensitivity == null ? '-' : (m.sensitivity * 100).toFixed(1) + '%';
    const spec = m.specificity == null ? '-' : (m.specificity * 100).toFixed(1) + '%';
    console.log(`  ${k.padEnd(28)} sensitivity=${sens} specificity=${spec} (tp${m.tp}/fp${m.fp}/tn${m.tn}/fn${m.fn})`);
  }
  if (skips.length) {
    const byReason = {};
    for (const s of skips) byReason[s.reason] = (byReason[s.reason] || 0) + 1;
    console.log('\n[비교 제외]');
    for (const [reason, n] of Object.entries(byReason)) console.log(`  ${reason}: ${n}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
