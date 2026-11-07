// P0-13 성능 기준선 ① — 웹 빌드(dist/web)의 청크별 원본·gzip·brotli 크기.
// index.html이 직접 참조하는 파일(script src·link href·modulepreload)을 "초기 로드", 나머지 JS/CSS를
// "나중 로드(동적 import)"로 나눈다. 먼저 `npm run build:web`.
//
//   node scripts/perf/bundle-size.mjs [--dir dist/web] [--json out.json]
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { markdownTable, parseArgs } from './lib/perfLib.mjs';

/** index.html이 참조하는 로컬 자산 경로(./assets/x.js → assets/x.js). */
export function initialAssetsFromHtml(html) {
  const refs = new Set();
  const re = /<(?:script|link)\b[^>]*?\b(?:src|href)=["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ref = m[1];
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || ref.startsWith('data:')) continue;
    refs.add(ref.replace(/^\.?\//, ''));
  }
  return refs;
}

export function measureFile(buf) {
  return {
    raw: buf.length,
    gzip: zlib.gzipSync(buf, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, base));
    else out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export function summarize(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const initial = initialAssetsFromHtml(html);
  initial.add('index.html');
  const files = walk(dir)
    .filter(f => /\.(?:js|css|html)$/.test(f))
    .map(f => ({ file: f, initial: initial.has(f), ...measureFile(fs.readFileSync(path.join(dir, f))) }))
    .sort((a, b) => b.raw - a.raw);
  const sum = (list, key) => list.reduce((s, f) => s + f[key], 0);
  const groups = { initial: files.filter(f => f.initial), lazy: files.filter(f => !f.initial) };
  const totals = Object.fromEntries(Object.entries(groups).map(([k, list]) => [k, {
    files: list.length, raw: sum(list, 'raw'), gzip: sum(list, 'gzip'), brotli: sum(list, 'brotli'),
  }]));
  const otherAssets = walk(dir).filter(f => !/\.(?:js|css|html)$/.test(f));
  const otherBytes = otherAssets.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0);
  return { files, totals, other: { files: otherAssets.length, raw: otherBytes } };
}

const kb = n => (n / 1024).toFixed(1);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.resolve(typeof args.dir === 'string' ? args.dir : 'dist/web');
  if (!fs.existsSync(path.join(dir, 'index.html'))) {
    console.error(`bundle-size: ${dir}/index.html 이 없습니다 — 먼저 npm run build:web`);
    process.exit(1);
  }
  const result = summarize(dir);
  console.log(markdownTable(
    ['파일', '구분', '원본 KiB', 'gzip KiB', 'brotli KiB'],
    result.files.map(f => [f.file, f.initial ? '초기' : '나중', kb(f.raw), kb(f.gzip), kb(f.brotli)]),
  ));
  console.log('');
  console.log(markdownTable(
    ['구분', '파일 수', '원본 KiB', 'gzip KiB', 'brotli KiB'],
    [
      ['초기 로드(index.html 참조)', result.totals.initial.files, kb(result.totals.initial.raw), kb(result.totals.initial.gzip), kb(result.totals.initial.brotli)],
      ['나중 로드(동적 import)', result.totals.lazy.files, kb(result.totals.lazy.raw), kb(result.totals.lazy.gzip), kb(result.totals.lazy.brotli)],
      ['그 밖의 정적 파일(이미지·xlsx 등)', result.other.files, kb(result.other.raw), '—', '—'],
    ],
  ));
  if (typeof args.json === 'string') fs.writeFileSync(args.json, `${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
