// 평가 모듈 등록(사이드이펙트 import) — 운영 등록 순서는 이 파일 한 곳에서 정한다(REFACTORING_ROADMAP Phase 2 C5, P2-49).
// 순서는 옛 App.jsx 62-67줄 그대로다. getAllModules()가 이 순서를 돌려주고 화면 목록·일괄 가져오기가 그 순서를 쓰므로 바꾸지 않는다.
// 테스트는 이 파일을 쓰지 않고 각자 필요한 모듈을 자체 순서로 등록한다(계획 phase2-c5c6-plan.md 원칙 3).
import './knee';
import './spine';
import './cervical';
import './shoulder';
import './elbow';
import './wrist';
