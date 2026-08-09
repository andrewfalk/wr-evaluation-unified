import { Router } from 'express';
import express from 'express';

// 트랙 2 계획 F/G — electron-updater가 latest.yml/canary.yml/설치본/.blockmap을
// 내려받는 정적 경로 + 관리자 on/off 스위치(update-policy.json)를 같은 디렉터리에서 서빙한다.
// 운영자가 docker exec 없이 단순 파일 복사로 배포할 수 있도록 host bind mount로 연결됨
// (docker-compose.yml의 app.volumes 참고) — 컨테이너 재시작 없이도 새 파일을 즉시 인식해야
// 하므로 부팅 시 1회 존재 확인 후 캐싱하는 방식은 쓰지 않는다.
const DEFAULT_UPDATES_DIR = process.env.UPDATES_DIR || '/app/updates';

// PHI 없음(설치본·yml·정책 파일뿐) — 인증 없이 서빙한다. 보안 경계는 (a) 인트라넷 네트워크
// 경계 자체(로그인 페이지도 동일 경계에 의존), (b) sha512 무결성(electron-updater 기본 동작),
// (c) 코드서명(후속 과제)이지, 이 라우트의 세션 인증이 아니다.
// updatesDir 파라미터는 테스트에서 임시 디렉터리를 주입하기 위한 것 — 실제 서버는 인자
// 없이 호출해 DEFAULT_UPDATES_DIR(process.env.UPDATES_DIR)을 그대로 쓴다.
export function createUpdatesRouter(updatesDir: string = DEFAULT_UPDATES_DIR): Router {
  const router = Router();

  // fs.existsSync로 등록을 조건화하지 않는다 — express.static은 디렉터리가 없으면
  // 다음 미들웨어(아래 404)로 자연스럽게 넘어가고, 서버 기동 후 운영자가 디렉터리를
  // 새로 만들어도(첫 배포 시점) 재시작 없이 즉시 인식된다.
  router.use(express.static(updatesDir, {
    index: false,
    dotfiles: 'ignore',
    redirect: false,
    setHeaders(res, filePath) {
      // update-policy.json은 관리자가 값을 바꾼 즉시(재시작 없이) 반영돼야 하므로 무조건 no-cache.
      res.setHeader('Cache-Control', 'no-cache');
      if (filePath.endsWith('.exe') || filePath.endsWith('.blockmap')) {
        res.setHeader('Content-Type', 'application/octet-stream');
        // Content-Disposition은 의도적으로 설정하지 않는다 — productName에 한글이 포함돼
        // Node의 헤더 값 검증이 Latin1 밖 문자를 거부해 ERR_INVALID_CHAR가 발생한다.
        // electron-updater는 URL/yml의 경로로 파일을 특정하므로 이 헤더 자체가 불필요하다.
      } else if (filePath.endsWith('.yml') || filePath.endsWith('.yaml')) {
        res.setHeader('Content-Type', 'text/yaml; charset=utf-8');
      } else if (filePath.endsWith('.json')) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
      }
    },
  }));

  // 자체 종료(self-terminating) — 이 라우터가 처리 못 한 /updates/* 요청은 여기서 바로 404를
  // 반환한다. index.ts의 SPA catch-all로 흘러가면 index.html(200 OK)이 돌아와 electron-updater의
  // YAML 파싱이 원인 파악하기 어려운 방식으로 깨진다(반드시 SPA catch-all보다 먼저 마운트할 것).
  router.use((_req, res) => res.status(404).json({ error: 'Not found' }));

  return router;
}
