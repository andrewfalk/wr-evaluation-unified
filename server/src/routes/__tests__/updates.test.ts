import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createUpdatesRouter } from '../updates';

function makeApp(updatesDir: string) {
  const app = express();
  app.use('/updates', createUpdatesRouter(updatesDir));
  // SPA catch-all 대체 — 실제 index.ts처럼 /updates가 잡지 못한 경로만 여기로 흘러야 하는데,
  // updates.ts가 자체 404로 끝맺으므로 이 핸들러는 절대 호출되면 안 된다(호출되면 마운트
  // 순서/자체종료 버그가 재현된 것).
  app.get('*', (_req, res) => res.status(200).send('<html>SPA fallback — should never be hit under /updates/*</html>'));
  return app;
}

describe('GET /updates/*', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'wr-updates-router-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('latest.yml을 text/yaml로 제공', async () => {
    writeFileSync(path.join(dir, 'latest.yml'), 'version: 6.5.0\n', 'utf-8');
    const res = await request(makeApp(dir)).get('/updates/latest.yml');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/yaml/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.text).toContain('version: 6.5.0');
  });

  it('canary.yml도 동일하게 제공', async () => {
    writeFileSync(path.join(dir, 'canary.yml'), 'version: 6.5.0-canary.0\n', 'utf-8');
    const res = await request(makeApp(dir)).get('/updates/canary.yml');
    expect(res.status).toBe(200);
    expect(res.text).toContain('canary');
  });

  it('update-policy.json을 application/json + no-cache로 제공(G절 스위치)', async () => {
    writeFileSync(path.join(dir, 'update-policy.json'), JSON.stringify({ enabled: true, channels: ['canary'] }), 'utf-8');
    const res = await request(makeApp(dir)).get('/updates/update-policy.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.body).toEqual({ enabled: true, channels: ['canary'] });
  });

  it('.exe를 octet-stream으로 제공하고 Range 요청(부분 다운로드)을 지원', async () => {
    const content = Buffer.from('0123456789');
    writeFileSync(path.join(dir, 'Setup.exe'), content);
    const res = await request(makeApp(dir)).get('/updates/Setup.exe').set('Range', 'bytes=0-3');
    expect(res.status).toBe(206);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBeUndefined(); // F절 — 한글 파일명 ERR_INVALID_CHAR 회피
    expect(res.body.length || res.text.length).toBeGreaterThan(0);
  });

  it('.blockmap도 octet-stream, Content-Disposition 없음', async () => {
    writeFileSync(path.join(dir, 'Setup.exe.blockmap'), Buffer.from('bm'));
    const res = await request(makeApp(dir)).get('/updates/Setup.exe.blockmap');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toBeUndefined();
  });

  it('존재하지 않는 파일은 JSON 404를 반환하고 SPA HTML로 흐르지 않는다', async () => {
    const res = await request(makeApp(dir)).get('/updates/nonexistent.yml');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Not found' });
    expect(res.text).not.toContain('SPA fallback');
  });

  it('한글+공백 파일명을 정상 제공', async () => {
    const name = '직업성 질환 통합 평가 프로그램 Setup 6.5.0.exe';
    writeFileSync(path.join(dir, name), Buffer.from('installer'));
    const res = await request(makeApp(dir)).get(`/updates/${encodeURIComponent(name)}`);
    expect(res.status).toBe(200);
  });

  it('서버 시작 후(라우터 생성 후) 디렉터리가 새로 생겨도 재시작 없이 인식된다', async () => {
    // 아직 디렉터리 자체가 없는 상태에서 라우터를 만든다.
    const freshDir = path.join(dir, 'not-created-yet');
    const app = makeApp(freshDir);

    const before = await request(app).get('/updates/latest.yml');
    expect(before.status).toBe(404);

    // 이제야 디렉터리+파일을 만든다(운영자가 첫 배포 시점에 하는 것과 동일한 순서).
    const fs = await import('fs');
    fs.mkdirSync(freshDir, { recursive: true });
    fs.writeFileSync(path.join(freshDir, 'latest.yml'), 'version: 6.5.0\n', 'utf-8');

    const after = await request(app).get('/updates/latest.yml');
    expect(after.status).toBe(200);
  });
});
