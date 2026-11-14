// 지연 로딩 + 청크 실패 안내 — REFACTORING_ROADMAP Phase 2 P-2a(P2-22).
//
// React.lazy로 나눈 화면은 처음 열 때 별도 JS 청크를 내려받는다. 서버가 새 버전으로 바뀐 뒤에도 열려 있던 탭은 옛
// index.html을 들고 있어, 사라진 옛 해시 청크를 부르면 실패한다(서버는 SPA fallback으로 HTML을 주고 import가 거부됨 —
// 릴리스 게이트 ⑦). 앱에는 오류 경계가 없어 그대로 두면 화면 전체가 멈추므로, 실패하면 그 자리에 "새로고침" 안내를
// 그리는 컴포넌트로 대신한다. 네트워크가 잠깐 끊긴 경우도 같은 안내(새로고침으로 다시 받음).
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';

export const CHUNK_LOAD_FAILED_MESSAGE = '앱이 업데이트되었거나 연결이 끊겨 화면 일부를 불러오지 못했습니다. 새로고침한 뒤 다시 시도하세요.';

function ChunkLoadFailed() {
  return (
    <div className="modal-overlay" role="alertdialog" aria-label="화면을 불러오지 못함">
      <div className="modal">
        <p>{CHUNK_LOAD_FAILED_MESSAGE}</p>
        <div className="modal-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>새로고침</button>
        </div>
      </div>
    </div>
  );
}

/**
 * React.lazy와 같지만 청크 로드가 실패하면 새로고침 안내를 렌더한다(던지지 않음).
 * `load`는 `{ default: Component }`를 돌려주는 동적 import(이름 있는 export면 `.then(m => ({ default: m.X }))`).
 */
export function lazyWithReload<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
): LazyExoticComponent<ComponentType<P>> {
  return lazy(() => load().catch((error: unknown) => {
    console.warn('[lazy] chunk load failed', error);
    return { default: ChunkLoadFailed as ComponentType<P> };
  }));
}
