// 작업 화면의 수명(계정 전환 수정 AS-4). 계정이 바뀌면 화면(App)이 다시 띄워진다 — 옛 인스턴스의 setState는 무시되지만,
// `await`·확인창 뒤에 이어지는 React 밖 부수효과(저장소·파일 쓰기와 삭제, 브리지 호출, 알림·확인창)는 그대로 실행돼
// 이전 계정의 환자 이름이 새 계정 화면에 뜨거나 로컬 자동저장의 유일한 사본이 지워질 수 있다.
// App 범위의 훅·컴포넌트는 이 훅을 각자 부르고(App이 내려가면 함께 내려간다) `await`마다 isAlive()를 확인한다.
// 알림·확인창은 guardAlert/guardConfirm으로 감싼다 — 그 훅이 import한 showAlert/showConfirm을 그대로 감싸므로 테스트의
// 대화상자 mock도 그대로 듣는다.
import { useEffect, useMemo, useRef } from 'react';

type AlertFn = (message: string) => Promise<void> | void;
type ConfirmFn = (message: string) => Promise<boolean> | boolean;

export interface WorkspaceLifetime {
  /** 화면이 아직 떠 있으면 true(StrictMode의 시험 언마운트 뒤 다시 마운트되면 true로 돌아온다). */
  isAlive: () => boolean;
  /** 화면이 떠 있을 때만 알림을 띄우는 함수로 감싼다. */
  guardAlert: (alert: AlertFn) => (message: string) => Promise<void>;
  /** 화면이 떠 있을 때만 묻는 함수로 감싼다 — 내려간 뒤면 false, 묻는 동안 내려갔어도 false. */
  guardConfirm: (confirm: ConfirmFn) => (message: string) => Promise<boolean>;
}

export function useWorkspaceLifetime(): WorkspaceLifetime {
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => { aliveRef.current = false; };
  }, []);
  return useMemo<WorkspaceLifetime>(() => {
    const isAlive = () => aliveRef.current;
    return {
      isAlive,
      guardAlert: (alert) => async (message) => {
        if (!isAlive()) return;
        await alert(message);
      },
      guardConfirm: (confirm) => async (message) => {
        if (!isAlive()) return false;
        const ok = await confirm(message);
        return !!ok && isAlive();
      },
    };
  }, []);
}

/**
 * 수명 확인 + 그 수명으로 감싼 알림·확인창(고정 참조 — useCallback 의존성에 넣어도 바뀌지 않는다).
 * 넘기는 alert/confirm은 그 훅이 import한 함수(모듈 수준이라 고정)여야 한다.
 */
export function useGuardedDialogs(alert: AlertFn, confirm?: ConfirmFn): {
  isAlive: () => boolean;
  alertAlive: (message: string) => Promise<void>;
  confirmAlive: (message: string) => Promise<boolean>;
} {
  const { isAlive, guardAlert, guardConfirm } = useWorkspaceLifetime();
  return useMemo(() => ({
    isAlive,
    alertAlive: guardAlert(alert),
    confirmAlive: confirm ? guardConfirm(confirm) : async () => false,
  }), [isAlive, guardAlert, guardConfirm, alert, confirm]);
}
