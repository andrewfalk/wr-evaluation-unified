// 자식 프로세스용 도우미 — vercelAnalyzeCjsLoad.test.mjs가 실행한다(직접 쓰는 파일이 아님).
//
// Vercel(@vercel/node)은 루트 package.json에 "type":"module"이 없으면 .js 함수 파일을 CommonJS로 변환해 로드한다
// ("Node.js functions are compiled from ESM to CommonJS"). 그러면 import가 require()가 되어, 그 파일이 가져오는
// 모듈이 ESM이면 require(esm)을 지원하지 않는 Node에서 로드 단계에 실패한다. 그 동작을 흉내 낸다:
// 함수 파일만 TypeScript로 CJS 변환하고, 그 파일이 require하는 나머지(계약 .cjs·라이브러리)는 Node가 있는 그대로 로드한다.
// 외부 통신이 없도록 Upstash만 가짜로 바꾸고 fetch를 가로채, 핸들러를 한 번 호출해 가져온 값이 실제로 쓰이는지까지 본다
// (로드만 되고 default import가 undefined라 첫 호출에서 죽는 경우도 같은 증상이다).
//
// 사용법: node [--no-experimental-require-module] vercelFunctionCjsLoader.cjs <함수 파일>
// 출력: 마지막 줄에 JSON 한 줄. 종료 코드 10=로드 실패, 11=handler 없음, 12=호출 중 예외.
'use strict';
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const target = path.resolve(process.argv[2]);
const emit = (value) => console.log(JSON.stringify(value));

const originalJs = Module._extensions['.js'];
Module._extensions['.js'] = function loadJs(module, filename) {
  if (path.resolve(filename) !== target) return originalJs(module, filename);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  });
  module._compile(outputText, filename);
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (request === '@upstash/redis') return { Redis: class {} };
  if (request === '@upstash/ratelimit') {
    class Ratelimit {
      async limit() { return { success: true, reset: Date.now() + 60_000 }; }
      static slidingWindow() { return {}; }
      static fixedWindow() { return {}; }
    }
    return { Ratelimit };
  }
  return originalLoad.call(this, request, ...rest);
};

const ORIGIN = 'https://wr.example.app';
const TOKEN = 'client-token-0123456789';
Object.assign(process.env, {
  APP_ORIGIN: ORIGIN, WEB_AI_CLIENT_TOKEN: TOKEN, UPSTASH_REDIS_REST_URL: 'https://redis.example',
  UPSTASH_REDIS_REST_TOKEN: 'redis-token', GEMINI_API_KEY: 'gemini-key', CLAUDE_API_KEY: 'claude-key',
});

const upstreamBodies = [];
globalThis.fetch = async (_url, init) => {
  upstreamBodies.push(String(init && init.body));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '가짜 분석' }] } }] }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
};

let handler;
try {
  const mod = require(target);
  handler = mod.default;
} catch (err) {
  emit({ stage: 'load', code: err.code || err.name, message: String(err.message).split('\n')[0].slice(0, 300) });
  process.exit(10);
}
if (typeof handler !== 'function') {
  emit({ stage: 'handler', message: 'default export가 함수가 아님' });
  process.exit(11);
}

const INPUT = {
  schemaVersion: 1,
  demographics: { ageYears: 52, gender: 'male', heightCm: 170, weightKg: 70, bmi: 24.2, hypertension: false, diabetes: false },
  diagnoses: [], jobs: [], modules: {},
};
const res = {
  headers: {}, statusCode: 200, body: undefined,
  setHeader(key, value) { this.headers[key] = value; },
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; },
  end() { return this; },
};
const req = {
  method: 'POST',
  headers: { origin: ORIGIN, 'x-wr-client': TOKEN, 'x-forwarded-for': '203.0.113.7' },
  body: { input: INPUT, model: 'gemini-2.5-flash' },
};

handler(req, res).then(() => {
  // 서버가 직접 조립한 프롬프트가 실제로 업스트림 본문에 실렸는지(계약 함수가 undefined가 아닌지) 확인한다.
  const { buildPrompt } = require(path.join(path.dirname(target), '..', 'shared', 'dist', 'aiPrompt.cjs'));
  const promptPrefix = JSON.stringify(buildPrompt(INPUT)).slice(1, 80);
  emit({
    stage: 'ok', status: res.statusCode, text: res.body && res.body.text,
    upstreamCalls: upstreamBodies.length, promptSent: upstreamBodies.length === 1 && upstreamBodies[0].includes(promptPrefix),
  });
}).catch((err) => {
  emit({ stage: 'invoke', code: err.code || err.name, message: String(err.message).split('\n')[0].slice(0, 300) });
  process.exit(12);
});
