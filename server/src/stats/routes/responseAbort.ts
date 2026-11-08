// 응답이 끝나기 전에 클라이언트 연결이 끊겼는지 감지하는 AbortSignal.
//
// `req.on('close')`를 쓰면 안 된다 — Node 16+에서 IncomingMessage의 'close'는 요청 본문 수신이
// 끝나면 발생하므로 정상 POST도 취소된다. 실제 연결 중단은 응답 객체의 'close'가
// `writableFinished === false`로 올 때다. 리스너를 달기 전에 이미 끊긴 경우도 처리한다.
import type { Response } from 'express';

export interface ResponseAbort {
  signal: AbortSignal;
  /** 응답을 정상적으로 마친 뒤(또는 더 쓸 일이 없을 때) 리스너를 정리한다. */
  dispose(): void;
}

export function createResponseAbort(res: Pick<Response, 'once' | 'off' | 'destroyed' | 'writableFinished'>): ResponseAbort {
  const controller = new AbortController();
  const onClose = (): void => {
    if (!res.writableFinished) controller.abort();
  };
  if (res.destroyed && !res.writableFinished) {
    controller.abort();
  } else {
    res.once('close', onClose);
  }
  return {
    signal: controller.signal,
    dispose: () => { res.off('close', onClose); },
  };
}
