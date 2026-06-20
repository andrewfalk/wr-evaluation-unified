// 6.0-B2 보조 — 전문의 수기측정 엑셀(CSV) → annotations.json(AnnotationSetSchema) + manifest 스켈레톤.
// 전문의는 clip 단위 raw값(각도°·누적초·횟수)만 채우고, 본 스크립트가 퍼-데이 환산·계약 형식화를 한다.
// 의존성 없음(plain node). 최종 형식 검증은 다운스트림 videoValidateReport.mjs(AnnotationSetSchema.parse)가 한다.
//
// 실행: node scripts/b2AnnotationsFromCsv.mjs --csv <gold.csv>
//          [--out-annotations annotations.json] [--out-manifest manifest.skeleton.json]
//          [--video-dir <영상폴더>]
//
// --video-dir 주면 manifest videoPath = <영상폴더>/<clipFileName>으로 자동 채움(손으로 경로 수정 불필요).
//   미지정 시 'TODO_실제경로/<파일명>' placeholder(IT가 수동 수정).
// 환산(누적초 → 1일 노출): perDay = (postureSec / clipDurationSec) × activeMinutesPerDay.
//   clipDurationSec·activeMinutesPerDay가 없으면 그 시간형 변수는 생략(비교 제외).

import fs from 'node:fs';

// 엑셀 칸(CSV 열) → FeatureKey 매핑. time=누적초 환산, angle=원각도.
const TIME_FEATURES = {
  trunkOver45Sec: { key: 'trunkFlexionOver45Duration', unit: 'minutes_per_day' },
  neckNonNeutralSec: { key: 'neckFlexionOver20HoursPerDay', unit: 'hours_per_day' },
  squatSec: { key: 'squatDuration', unit: 'minutes_per_day' },
  overheadSec: { key: 'overheadHours', unit: 'hours_per_day' },
};
const ANGLE_FEATURES = {
  trunkPeakDeg: { key: 'trunkPostureG', unit: 'degrees' },
};
// activeModules 도출(어떤 변수가 채워졌나 → 모듈).
const FEATURE_MODULE = {
  trunkFlexionOver45Duration: 'spine', trunkPostureG: 'spine',
  neckFlexionOver20HoursPerDay: 'cervical', squatDuration: 'knee', overheadHours: 'shoulder',
};

function parseArgs(argv) {
  const o = { outAnnotations: 'annotations.json', outManifest: 'manifest.skeleton.json' };
  for (let i = 2; i < argv.length; i += 1) {
    if (argv[i] === '--csv') o.csv = argv[++i];
    else if (argv[i] === '--out-annotations') o.outAnnotations = argv[++i];
    else if (argv[i] === '--out-manifest') o.outManifest = argv[++i];
    else if (argv[i] === '--video-dir') o.videoDir = argv[++i];
  }
  if (!o.csv) { console.error('usage: node scripts/b2AnnotationsFromCsv.mjs --csv <gold.csv> [--out-annotations f] [--out-manifest f] [--video-dir <dir>]'); process.exit(2); }
  return o;
}

// 최소 CSV 파서(따옴표 안 쉼표 허용). BOM 제거.
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i += 1; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const num = (v) => { const n = Number(String(v).trim()); return Number.isFinite(n) && String(v).trim() !== '' ? n : null; };
const str = (v) => { const t = String(v ?? '').trim(); return t === '' ? undefined : t; };

function main() {
  const args = parseArgs(process.argv);
  const rows = parseCsv(fs.readFileSync(args.csv, 'utf-8'));
  if (rows.length < 2) { console.error('데이터 행이 없습니다(헤더 + 1행 이상 필요).'); process.exit(2); }
  const header = rows[0].map((h) => h.trim());
  const col = (r, name) => { const i = header.indexOf(name); return i < 0 ? '' : (r[i] ?? ''); };

  const annotations = [];
  const cases = [];
  const warns = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const videoRef = str(col(row, 'videoRef'));
    if (!videoRef) { warns.push(`행 ${r + 1}: videoRef 비어 건너뜀`); continue; }
    const caseId = str(col(row, 'caseId')) || videoRef;
    const clipDur = num(col(row, 'clipDurationSec'));
    const activeMin = num(col(row, 'activeMinutesPerDay'));

    const features = {};
    for (const [csvCol, m] of Object.entries(ANGLE_FEATURES)) {
      const v = num(col(row, csvCol));
      if (v != null) features[m.key] = { kind: 'numeric', value: v, unit: m.unit };
    }
    for (const [csvCol, m] of Object.entries(TIME_FEATURES)) {
      const sec = num(col(row, csvCol));
      if (sec == null) continue;
      if (clipDur == null || clipDur <= 0 || activeMin == null) {
        warns.push(`행 ${r + 1}(${videoRef}): ${csvCol} 있으나 clipDurationSec/activeMinutesPerDay 없어 ${m.key} 생략`);
        continue;
      }
      const ratio = sec / clipDur;
      const perDay = m.unit === 'hours_per_day' ? (ratio * activeMin) / 60 : ratio * activeMin;
      features[m.key] = { kind: 'numeric', value: Math.round(perDay * 100) / 100, unit: m.unit };
    }
    if (Object.keys(features).length === 0) { warns.push(`행 ${r + 1}(${videoRef}): 매핑되는 측정값 없음 — annotation 생략`); continue; }

    const strat = {};
    for (const f of ['viewpoint', 'occlusionLevel', 'clothing', 'cameraHeight', 'workType']) {
      const v = str(col(row, f)); if (v) strat[f] = v;
    }
    const mp = str(col(row, 'multiplePeople'));
    if (mp) strat.multiplePeople = /^y(es)?$/i.test(mp);

    const date = str(col(row, 'annotatedDate')) || new Date().toISOString().slice(0, 10);
    annotations.push({
      id: videoRef,
      videoRef,
      annotator: str(col(row, 'annotator')) || 'unknown',
      annotatedAt: `${date}T00:00:00Z`,
      stratification: strat,
      features,
      segments: [],
    });

    // manifest 스켈레톤 case. videoPath는 --video-dir 주면 자동, 아니면 TODO placeholder. targetTrackId는
    // 보통 빈칸(AI가 dominant track 자동 선택); 다인원에서 비주인공 측정 시에만 IT가 채움.
    const modules = [...new Set(Object.keys(features).map((k) => FEATURE_MODULE[k]).filter(Boolean))];
    const fileName = str(col(row, 'clipFileName')) || videoRef;
    const videoPath = args.videoDir
      ? `${args.videoDir.replace(/[\\/]+$/, '')}/${fileName}`
      : `TODO_실제경로/${fileName}`;
    cases.push({
      caseId,
      videoRef,
      annotationId: videoRef,
      activeMinutesPerDay: activeMin,
      activeModules: modules,
      clips: [{ videoPath, viewpoint: strat.viewpoint || 'sagittal', targetTrackId: '' }],
    });
  }

  fs.writeFileSync(args.outAnnotations, JSON.stringify({ version: 1, annotations }, null, 2), 'utf-8');
  fs.writeFileSync(args.outManifest, JSON.stringify({ version: 1, cases }, null, 2), 'utf-8');
  console.log(`[b2-annotations] annotations ${annotations.length}건 → ${args.outAnnotations}`);
  console.log(`[b2-annotations] manifest 스켈레톤 ${cases.length}건 → ${args.outManifest} (videoPath·targetTrackId 채우세요)`);
  if (warns.length) { console.log('\n[경고]'); for (const w of warns) console.log('  ' + w); }
}

main();
