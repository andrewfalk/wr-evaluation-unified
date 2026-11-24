// 늦게 내려받는 코드 조각의 로드 실패 안내(Phase 2 C7-a FX-5).
//
// 내보내기·EMR 다학제 회신 입력·일괄입력 양식(exportService 조각)과 테스트 환자 만들기(createTestPatients 조각)는 처음 쓸 때
// 별도 JS 조각을 내려받는다. 서버가 새 버전으로 바뀐 뒤에도 열려 있던 탭이 사라진 옛 조각을 부르면 import가 실패하는데, 그동안은
// 브라우저의 영어 메시지(예: "Failed to fetch dynamically imported module")가 그대로 알림에 떴다. import 단계만 이 함수로 감싸
// 실패하면 화면 지연 로딩(lazyWithReload)과 같은 한국어 안내 문구의 ChunkLoadError로 바꾼다 — 그 뒤 단계(내보내기 자체)의 오류는
// 그대로 둔다. 문자열로 판별하지 않는다. 효과는 이 코드가 실린 화면이 열려 있을 때부터(다음 업데이트 때) 난다.
import { CHUNK_LOAD_FAILED_MESSAGE } from '../components/lazyWithReload';

export class ChunkLoadError extends Error {
  constructor(cause: unknown) {
    super(CHUNK_LOAD_FAILED_MESSAGE);
    this.name = 'ChunkLoadError';
    this.cause = cause;
  }
}

/** 동적 import를 부른다. import가 실패하면 ChunkLoadError(문구 = CHUNK_LOAD_FAILED_MESSAGE)로 던진다. */
export async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load();
  } catch (error) {
    console.warn('[chunk] load failed', error);
    throw new ChunkLoadError(error);
  }
}
