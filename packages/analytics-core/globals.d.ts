// "types": [] 라 Node·DOM 전역 타입이 자동으로 안 들어온다(의도적 — Node 전용 API를
// 실수로 쓰면 타입 에러로 잡히길 원함). TextEncoder는 Node·모든 현대 브라우저가 공통으로
// 제공하는 표준 전역이라 여기 최소 선언만 둔다("DOM" lib 전체를 끌어와 window/document 같은
// 브라우저 전용 전역까지 타입체크를 통과시키고 싶지 않다).
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
