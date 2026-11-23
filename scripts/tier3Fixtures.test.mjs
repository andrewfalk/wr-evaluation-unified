import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// scripts/tier3/fixtures/shell-7.1.4/의 사본이 7.1.4 릴리스(커밋 77e6686)의 electron/ 파일과 같은지 — git 블롭 해시로 비교한다.
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tier3', 'fixtures', 'shell-7.1.4');
// 파일 → 77e6686의 블롭 해시. (해시를 파일 이름 옆에 두지 않는다 — 비밀 정보 검사가 이름의 단어와 해시를 키·값으로 읽는다.)
const FILES = { audit: 'audit.js', queue: 'auditQueue.js', claims: 'accessTokenClaims.js' };
const BLOBS_77E6686 = {
  audit: '7fc1dc0afc6725b58d067df6c65c93a715ef2a51',
  queue: '6247ba56210de72149382217cb5861f8d2a54570',
  claims: '4b049106cc21965d953ce5b4fd86ba4d2ee8b2f9',
};

const gitBlobSha = (buf) => crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');

describe('Tier-3 7.1.4 설치본 사본', () => {
  it.each(Object.keys(FILES))('%s 사본은 77e6686의 electron/ 파일과 같다', (id) => {
    const blob = BLOBS_77E6686[id];
    const content = fs.readFileSync(path.join(DIR, FILES[id])).toString('utf8').replace(/\r\n/g, '\n');
    expect(gitBlobSha(Buffer.from(content, 'utf8'))).toBe(blob);
  });
});
