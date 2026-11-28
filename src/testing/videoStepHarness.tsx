// 영상 분석 화면 특성화(P2-75a, Phase 2 C9 구간 D)용 도우미 — 실제 앱과 같은 모양으로 환자 상태를 들고 화면을 그린다.
// - `shared`는 환자 `data.shared`와 **같은 참조**로 넘긴다(되돌리기가 `indexOf(entry)`로 적용 이력을 찾는다 — 복제하면 못 찾는다).
// - `updatePatient(updater)`는 앱(usePatientCrud)처럼 `data`에 updater를 적용하고, `updateShared(obj)`는 `data.shared`를 통째로 바꾼다.
// - 단계마다 ① 그 사이에 화면이 부른 콜백(updateShared에 넘긴 videoAnalysis · updatePatient 호출 · onServerApplied)
//   ② 환자 상태에서 바뀐 부분(shared.videoAnalysis · modules) ③ 화면(DOM 한 요소 한 줄 · 폼 상태)을 적는다.
import { useState } from 'react';
import type { ComponentType } from 'react';
import { render } from '@testing-library/react';
import { formState, serializeDom } from './renderEvaluation';
import { VideoAnalysisStep } from '../core/components/VideoAnalysisStep';

export type Fields = Record<string, unknown>;

export interface VideoPatient {
  id: string;
  sync?: { serverId?: string; syncStatus?: string };
  data: { shared: Fields; modules: Record<string, Fields> };
}

interface StepProps {
  shared: Fields;
  updateShared: (next: Fields) => void;
  updatePatient: (updater: (data: VideoPatient['data']) => VideoPatient['data']) => void;
  activePatient: VideoPatient;
  activeModules: string[];
  session: unknown;
  settings: unknown;
  fixtureMode?: boolean;
  serverConfig?: unknown;
  onServerApplied?: (patient: unknown) => void;
}

// 본체는 P2-75a 때 JS였다(P2-75b-ts에서 TSX) — 어느 쪽이든 같은 모양으로 그리려고 props 모양을 여기 적는다.
const Step = VideoAnalysisStep as unknown as ComponentType<StepProps>;

export interface HarnessCall {
  kind: 'updateShared' | 'updatePatient' | 'onServerApplied';
  videoAnalysis?: unknown;
  patient?: unknown;
}

export interface VideoStep {
  step: string;
  calls: HarnessCall[];
  state: unknown;
  dom: string[];
  form: string[];
  events?: unknown[];
}

export interface HarnessOptions {
  patient: VideoPatient;
  activeModules: string[];
  session?: unknown;
  settings?: unknown;
  fixtureMode?: boolean;
  serverConfig?: unknown;
}

function stateSlice(patient: VideoPatient): Fields {
  return { videoAnalysis: patient.data.shared.videoAnalysis ?? null, modules: patient.data.modules };
}

export function renderVideoStep({ patient, activeModules, session = null, settings = {}, fixtureMode = false, serverConfig }: HarnessOptions) {
  const calls: HarnessCall[] = [];
  const steps: VideoStep[] = [];
  let current = patient;
  let lastState = JSON.stringify(stateSlice(patient));

  function Harness() {
    const [p, setP] = useState(patient);
    current = p;
    const updatePatient: StepProps['updatePatient'] = (updater) => {
      calls.push({ kind: 'updatePatient' });
      setP((prev) => ({ ...prev, data: updater(prev.data) }));
    };
    const updateShared: StepProps['updateShared'] = (next) => {
      calls.push({ kind: 'updateShared', videoAnalysis: next.videoAnalysis });
      setP((prev) => ({ ...prev, data: { ...prev.data, shared: next } }));
    };
    const onServerApplied = (serverPatient: unknown) => {
      calls.push({ kind: 'onServerApplied', patient: serverPatient });
    };
    return (
      <Step
        shared={p.data.shared}
        updateShared={updateShared}
        updatePatient={updatePatient}
        activePatient={p}
        activeModules={activeModules}
        session={session}
        settings={settings}
        fixtureMode={fixtureMode}
        {...(serverConfig !== undefined ? { serverConfig } : {})}
        onServerApplied={onServerApplied}
      />
    );
  }

  const view = render(<Harness />);

  return {
    view,
    steps,
    get patient(): VideoPatient { return current; },
    snap(step: string, events?: unknown[]): VideoStep {
      const now = JSON.stringify(stateSlice(current));
      const entry: VideoStep = {
        step,
        calls: calls.splice(0),
        state: now === lastState ? 'unchanged' : JSON.parse(now),
        dom: serializeDom(view.container),
        form: formState(view.container),
        ...(events ? { events } : {}),
      };
      lastState = now;
      steps.push(entry);
      return entry;
    },
  };
}

/** n번째 공정 카드. */
export function processCard(root: ParentNode, index: number): HTMLElement {
  const card = root.querySelectorAll<HTMLElement>('.va-process-card')[index];
  if (!card) throw new Error(`process card not found: ${index}`);
  return card;
}

/** 공정 카드 안의 칸(직업·공정명·점유율·활동시간·분석 프로필). */
export function processField(card: ParentNode, field: 'job' | 'name' | 'share' | 'active' | 'profile'): HTMLInputElement | HTMLSelectElement {
  const selector = {
    job: '.va-pf-job select',
    name: '.va-pf-name input',
    share: '.va-pf-share input',
    active: '.va-pf-active input',
    profile: '.va-pf-profile select',
  }[field];
  const el = card.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
  if (!el) throw new Error(`process field not found: ${field}`);
  return el;
}

/** featureKey 글자가 머리(code)에 있는 제안·후보 카드들. */
export function suggestCards(root: ParentNode, featureKey: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('li.va-suggest-card'))
    .filter((li) => (li.querySelector('.va-suggest-key')?.textContent || '') === featureKey);
}

export function suggestCard(root: ParentNode, featureKey: string, index = 0): HTMLElement {
  const card = suggestCards(root, featureKey)[index];
  if (!card) throw new Error(`suggest card not found: ${featureKey}#${index}`);
  return card;
}
