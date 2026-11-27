// 화면 특성화(P2-67b, Phase 2 C8)용 렌더 헬퍼 — 모듈 평가 화면을 **앱과 같은 props 모양**으로 그린다.
//   · patient.data = { shared, module } (activeModules 없음 — StepContent.jsx가 넘기는 그대로)
//   · calc = manifest.computeCalc({ shared, module }) (useCommandsController.ts와 같은 인자), 모듈 데이터가 바뀔 때마다 다시 계산
//   · updateModule(updater)는 usePatientCrud.js와 같은 규칙(함수면 updater(현재 || {}), 객체면 얕게 합침)으로 상태를 바꾸고 다시 그린다
// 그리고 DOM을 한 요소 한 줄로 직렬화하고(serializeDom), 제어되는 폼 상태(select.value·checked·value)를 따로 적는다(formState) —
// 제어되는 <select>의 선택값과 체크 상태는 HTML 속성에 나오지 않기 때문이다.
import { useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { render } from '@testing-library/react';

type Fields = Record<string, unknown>;
type Updater = Fields | ((current: Fields) => Fields);

export interface EvaluationManifestLike {
  id: string;
  EvaluationComponent: ComponentType<Fields>;
  computeCalc(context: unknown): unknown;
}

export interface RenderEvaluationOptions {
  manifest: EvaluationManifestLike;
  shared: Fields;
  module: Fields | undefined;
  errors?: unknown;
  activeTab?: string;
}

export interface RenderedEvaluation {
  container: HTMLElement;
  /** updateModule이 만든 모듈 데이터, 부른 순서대로. */
  updates: Fields[];
  /** 지금 모듈 데이터. */
  current(): Fields;
  unmount(): void;
}

export function renderEvaluation({ manifest, shared, module, errors = null, activeTab }: RenderEvaluationOptions): RenderedEvaluation {
  const updates: Fields[] = [];
  const latest = { module: module || {} };

  function Harness() {
    const [mod, setMod] = useState<Fields>(module || {});
    const ref = useRef<Fields>(mod);
    const updateModule = (updater: Updater) => {
      const prev = ref.current || {};
      const next = typeof updater === 'function' ? updater(prev) : { ...prev, ...updater };
      ref.current = next;
      latest.module = next;
      updates.push(next);
      setMod(next);
    };
    const calc = manifest.computeCalc({ shared, module: mod });
    const Evaluation = manifest.EvaluationComponent;
    return (
      <Evaluation
        patient={{ id: 'golden-screen', moduleId: manifest.id, data: { shared, module: mod } }}
        calc={calc}
        activeTab={activeTab}
        setActiveTab={() => {}}
        updateModule={updateModule}
        errors={errors}
      />
    );
  }

  const { container, unmount } = render(<Harness />);
  return { container, updates, current: () => latest.module, unmount };
}

function attrs(el: Element): string {
  return Array.from(el.attributes).map(a => ` ${a.name}="${a.value}"`).join('');
}

/**
 * 한 요소 한 줄(속성 포함), 텍스트는 따로 한 줄. React가 `직력 {n}: {이름}`을 여러 텍스트 노드로 그리므로 **이어진 텍스트 노드는
 * 합친 뒤** 공백 연속만 한 칸으로 접고 앞뒤를 자른다(`직력 1`과 `직력1`이 구별되게). 공백만 있는 텍스트는 뺀다.
 */
export function serializeDom(root: Element): string[] {
  const lines: string[] = [];
  const walkChildren = (parent: Node, depth: number) => {
    const pad = '  '.repeat(depth);
    let text = '';
    const flush = () => {
      const collapsed = text.replace(/\s+/g, ' ').trim();
      if (collapsed) lines.push(`${pad}"${collapsed}"`);
      text = '';
    };
    parent.childNodes.forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
        return;
      }
      flush();
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as Element;
      const tag = el.tagName.toLowerCase();
      if (el.childNodes.length === 0) {
        lines.push(`${pad}<${tag}${attrs(el)} />`);
        return;
      }
      lines.push(`${pad}<${tag}${attrs(el)}>`);
      walkChildren(el, depth + 1);
    });
    flush();
  };
  walkChildren(root, 0);
  return lines;
}

/** 폼 컨트롤의 실제 상태(프로퍼티) — 문서 순서. 값이 빈 텍스트 칸과 꺼진 선택지는 뺀다. */
export function formState(root: Element): string[] {
  const out: string[] = [];
  root.querySelectorAll('input, select, textarea').forEach((node, i) => {
    if (node instanceof HTMLSelectElement) {
      out.push(`#${i} select value="${node.value}"`);
    } else if (node instanceof HTMLInputElement) {
      if (node.type === 'checkbox' || node.type === 'radio') {
        if (node.checked) out.push(`#${i} ${node.type} name="${node.name}" value="${node.value}" checked`);
      } else if (node.value !== '') {
        out.push(`#${i} input type="${node.type}" value="${node.value}"`);
      }
    } else if (node instanceof HTMLTextAreaElement) {
      if (node.value !== '') out.push(`#${i} textarea value="${node.value}"`);
    }
  });
  return out;
}
