import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { PatientData, SharedData } from '@wr/contracts';
import type { PatientRecord } from '../types/patient';
import type { SetPatients } from '../state/patientStore/usePatientsContainer';
import { showAlert, showConfirm } from '../utils/platform';
import { patientTx, type SharedPatchedPayload } from '../state/patientStore/transitions';
import { getEmrBridge } from '../../platform/bridge';
import { useGuardedDialogs } from '../../app/useWorkspaceLifetime';
import {
  EXTRACT_FAILURE_EXCEPTION, EXTRACT_FAILURE_PATIENT_MISMATCH, addExtractFailure, extractFailureReason, formatExtractFailures,
  type ExtractFailureTally,
} from './extractFailureReasons';
import { ChunkLoadError, loadChunk } from '../utils/loadChunk';

// 타입만 붙였다(P2-66h) — 실행 코드는 JS 시절과 같다(가드·기본값을 새로 넣지 않는다).

/** useEMRIntegration의 인자. session은 전이(sharedPatched)로 그대로 넘기기만 한다. */
export interface EMRIntegrationArgs {
  activePatient: PatientRecord | undefined;
  patients: PatientRecord[];
  selectedIds: Set<string>;
  session: unknown;
  setPatients: SetPatients;
  dirtyAssessmentPatientId: string | null;
}

/** 일괄 추출 진행 표시(MainHeader가 읽는다). */
export interface ExtractProgress {
  current: number;
  total: number;
  currentName: string;
  status: string;
}

/** useEMRIntegration의 반환 — App 컨트롤러(useEditingController)가 그대로 넘긴다. */
export interface EmrIntegrationApi {
  extractProgress: ExtractProgress | null;
  setExtractProgress: Dispatch<SetStateAction<ExtractProgress | null>>;
  handleInjectEMR: () => Promise<void>;
  handleInjectConsultReply: () => Promise<void>;
  handleEmrExtractBatch: () => Promise<void>;
  handleExtractConsultation: () => Promise<void>;
}

// 아래 셋은 셸(EMR 헬퍼)이 주는 값이라 런타임 보장은 없다 — 필드는 코드가 읽는 모양대로 적었을 뿐이니, 이 타입을 믿고
// 기존 `?.`·`|| []`를 지우지 않는다(셸 버전에 따라 필드가 없을 수 있다).
interface EmrInjectResult {
  success: boolean;
  message: string;
  truncatedFields: string[];
  failedFields: Array<{ field: string; reason: string }>;
}

interface EmrExtractRecordResult {
  success: boolean;
  patientNo: string;
  patientName: string;
  birthDate: string;
  gender: string;
  accidentDate: string;
  medicalRecord: string;
  highBloodPressure: string;
  diabetes: string;
  visitHistory: string;
  diseases: Array<{ code: string; name: string }>;
  multipleEntries: boolean;
  injuryDateMismatch: boolean;
}

interface EmrConsultationResult {
  success: boolean;
  consultations: Array<{ department: string; content: string }>;
  error: string;
  message: string;
}

type ConsultReplyKey = 'consultReplyOrtho' | 'consultReplyNeuro' | 'consultReplyRehab' | 'consultReplyOther';
type PatientWithData = PatientRecord & { data: PatientData };

export function useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients, dirtyAssessmentPatientId }: EMRIntegrationArgs): EmrIntegrationApi {
  // 적용 여부(receipt) — 전이 patient/sharedPatched는 적용 시점 목록으로 판정해 receipt에 적는다(P2-39b). 환자 스토어가
  // dispatch 때 전이를 동기로 실행하므로(P2-40a) **setPatients 다음 줄에서 읽는다**(그 뒤에는 읽지 않는다). 그 시점의 목록은
  // 앞서 dispatch된 갱신(같은 배치의 식별정보 변경 포함)이 전부 적용된 것이라 커밋을 기다릴 필요가 없다(옮기기 전
  // useCommitBarrier의 목적 — P2-40b에서 삭제). 판정이 없으면(전이가 실행되지 않음 — vi.fn() 테스트) 적용되지 않은 것으로 본다.
  // 전이가 던지면 예외는 이 호출(호출부의 catch)로 나온다 — 옮기기 전에는 렌더 중 오류였다.
  const applySharedPatch = (payload: Omit<SharedPatchedPayload, 'receipt'>): Promise<boolean> => {
    const receipt: NonNullable<SharedPatchedPayload['receipt']> = { applied: undefined };
    setPatients(patientTx.sharedPatched({ ...payload, receipt }));
    return Promise.resolve(receipt.applied === true);
  };
  const [extractProgress, setExtractProgress] = useState<ExtractProgress | null>(null);
  // 화면 수명(계정 전환 수정 AS-4) — 화면이 내려간 뒤에는(계정이 바뀜) 기다리던 EMR 작업이 다음 브리지 호출·알림·확인창을
  // 이어 가지 않는다. 네이티브·window 알림은 화면을 다시 띄워도 사라지지 않아 이전 계정 환자 이름이 새 계정 화면에 뜬다.
  const { isAlive, alertAlive, confirmAlive } = useGuardedDialogs(showAlert, showConfirm);

  const handleInjectEMR = async (): Promise<void> => {
    if (!activePatient || !getEmrBridge()?.injectEMR) return;
    if (dirtyAssessmentPatientId === activePatient.id) {
      await alertAlive('저장하지 않은 종합소견 편집 내용이 있습니다.\n"편집 완료"로 저장한 뒤 다시 시도하세요.');
      return;
    }
    const ok = await confirmAlive('EMR 소견서에 현재 환자 데이터를 직접 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { prepareEmrInjection } = await import('../utils/emrReport');
      const { EMR_TEXT_LIMIT_BYTES } = await import('../utils/emrText');

      const { fieldData, effective, bytes, confirmedDx, exposureSection } = prepareEmrInjection(activePatient);

      if (effective.hasInvalidOverride) {
        await alertAlive('저장된 종합소견 편집 데이터가 손상되어 전송할 수 없습니다.\n종합평가 화면에서 "깨진 편집 데이터 삭제" 후 다시 시도하세요.');
        return;
      }
      // isStale은 오버라이드가 유효할 때만 true(resolveAssessment) — 차단하지 않고 전송
      // 직전에 한 번 더 확인만 한다(정책: 화면 경고 배너 + 전송 직전 재확인).
      if (effective.isStale) {
        const proceedStale = await confirmAlive(
          '⚠ 직접 편집한 종합소견 이후 상병·직업·평가 데이터가 변경되었습니다(또는 프로그램 업데이트로 자동 생성 문구가 달라졌습니다).\n'
          + '전송될 내용은 편집 시점 그대로이며 최신 데이터와 다를 수 있습니다.\n\n'
          + '편집본을 그대로 전송하시겠습니까?'
        );
        if (!proceedStale) return;
      }
      // 전송 전 경고(종합소견 한도 초과 · 4.직업적 요인 한도 초과 · 확인 상병 0건/한도 초과)는 사유를 모아 확인창 한 번으로
      // 묻는다. 확인 상병 판정은 절단 전 원본 b5 기준(confirmedDx) — 이미 절단된
      // fieldData.txtAppvSickCont 길이로는 초과를 알 수 없다. EMR 헬퍼는 빈 값이면 칸을 건드리지
      // 않으므로(SetField early-return), 0건이면 EMR에 이미 들어 있던 값이 그대로 남는다.
      const warnings: string[] = [];
      let willTruncate = false;
      if (bytes > EMR_TEXT_LIMIT_BYTES) {
        const over = bytes - EMR_TEXT_LIMIT_BYTES;
        const reduceHint = effective.isOverride
          ? '직접 편집한 내용을 줄이면 byte를 줄일 수 있습니다.'
          : '종합평가 스텝에서 "패턴 그룹 사용"을 켜면 byte를 줄일 수 있습니다.';
        willTruncate = true;
        warnings.push(
          `⚠ 6.종합소견이 EMR 한도를 초과합니다.\n`
          + `${bytes.toLocaleString()} / ${EMR_TEXT_LIMIT_BYTES.toLocaleString()} byte (${over.toLocaleString()} byte 초과)\n`
          + `그대로 전송하면 끝부분이 "...(이하 생략)"으로 잘립니다.\n`
          + reduceHint
        );
      }
      // 4.직업적 요인(b6)도 절단 전 원본 기준(exposureSection). 줄이는 방법은 없어 알리기만 한다 — 전문은 소견서·엑셀에 남는다.
      if (exposureSection?.overLimit) {
        willTruncate = true;
        warnings.push(
          `⚠ 4.직업적 요인이 EMR 한도를 초과합니다.\n`
          + `${exposureSection.bytes.toLocaleString()} / ${EMR_TEXT_LIMIT_BYTES.toLocaleString()} byte (${(exposureSection.bytes - EMR_TEXT_LIMIT_BYTES).toLocaleString()} byte 초과)\n`
          + `그대로 전송하면 끝부분이 "...(이하 생략)"으로 잘려, 뒤에 오는 부위의 내용이 빠질 수 있습니다.\n`
          + '전문은 소견서와 엑셀 내보내기에 그대로 남습니다.'
        );
      }
      if (confirmedDx?.isEmpty) {
        warnings.push(
          '⚠ 종합소견에서 "확인"으로 입력된 상병이 없습니다.\n'
          + '"확인 상병" 칸은 전송되지 않으며, EMR에 이미 입력된 값이 있으면 그대로 남습니다.\n'
          + '필요하면 EMR에서 직접 지워 주세요.'
        );
      } else if (confirmedDx?.overLimit) {
        willTruncate = true;
        warnings.push(
          `⚠ 확인 상병이 EMR 한도를 초과합니다.\n`
          + `${confirmedDx.bytes.toLocaleString()} / ${EMR_TEXT_LIMIT_BYTES.toLocaleString()} byte\n`
          + `그대로 전송하면 끝부분이 "...(이하 생략)"으로 잘립니다.`
        );
      }
      if (warnings.length > 0) {
        const proceed = await confirmAlive(
          warnings.join('\n\n') + '\n\n' + (willTruncate ? '잘린 상태로 계속 전송하시겠습니까?' : '계속 전송하시겠습니까?')
        );
        if (!proceed) return;
      }

      if (!isAlive()) return;
      // 브리지·injectEMR은 함수 첫 줄에서 확인했다(! — 다시 묻지 않는 지금 동작 그대로).
      const result: EmrInjectResult = await getEmrBridge()!.injectEMR!({ ...fieldData, _source: effective.isOverride ? 'edited' : 'auto' });
      if (result.success) {
        let msg = `${result.message}`;
        if (result.truncatedFields?.length > 0) {
          msg += `\n\n⚠ 길이 제한으로 잘린 필드: ${result.truncatedFields.join(', ')}`;
        }
        if (result.failedFields?.length > 0) {
          msg += `\n\n일부 실패:\n${result.failedFields.map(f => `- ${f.field}: ${f.reason}`).join('\n')}`;
        }
        await alertAlive(msg);
      } else {
        await alertAlive(`EMR 입력 실패: ${result.message}`);
      }
    } catch (err) { await alertAlive('EMR 입력 오류: ' + (err as Error).message); }
  };

  const handleInjectConsultReply = async (): Promise<void> => {
    if (!activePatient || !getEmrBridge()?.injectEMR) return;
    const ok = await confirmAlive('다학제 회신 내용을 EMR 종합소견 2,3번 칸에 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { generateConsultReplyFieldData } = await loadChunk(() => import('../utils/exportService'));
      const fieldData = generateConsultReplyFieldData(activePatient);
      if (!isAlive()) return;
      // 브리지·injectEMR은 함수 첫 줄에서 확인했다(! — 다시 묻지 않는 지금 동작 그대로).
      const result: EmrInjectResult = await getEmrBridge()!.injectEMR!(fieldData);
      if (result.success) {
        let msg = `${result.message}`;
        if (result.truncatedFields?.length > 0) {
          msg += `\n\n⚠ 길이 제한으로 잘린 필드: ${result.truncatedFields.join(', ')}`;
        }
        if (result.failedFields?.length > 0) {
          msg += `\n\n일부 실패:\n${result.failedFields.map(f => `- ${f.field}: ${f.reason}`).join('\n')}`;
        }
        await alertAlive(msg);
      } else {
        await alertAlive(`다학제 회신 입력 실패: ${result.message}`);
      }
    } catch (err) {
      // 코드 조각을 내려받지 못했으면 새로고침 안내만(FX-5), 그 밖의 오류는 전과 같다.
      await alertAlive(err instanceof ChunkLoadError ? err.message : '다학제 회신 입력 오류: ' + (err as Error).message);
    }
  };

  // EMR 데이터 일괄 추출 (선택된 환자들의 patientNo 기반)
  const handleEmrExtractBatch = async (): Promise<void> => {
    if (!getEmrBridge()?.extractRecord) return;
    // 등록번호가 있는 환자만 남기므로 data가 있다(단언 — 걸러 내는 식은 그대로).
    const targets = (selectedIds.size > 0
      ? patients.filter(p => selectedIds.has(p.id) && p.data?.shared?.patientNo)
      : (activePatient?.data?.shared?.patientNo ? [activePatient] : [])) as PatientWithData[];
    if (targets.length === 0) {
      await alertAlive('선택된 환자 중 환자등록번호가 입력된 환자가 없습니다.');
      return;
    }
    const ok = await confirmAlive(`${targets.length}명의 환자 데이터를 EMR에서 추출합니다.\n진료기록분석지 페이지가 열려있는지 확인하세요.\n\n계속하시겠습니까?`);
    if (!ok) return;

    let successCount = 0, failCount = 0, skippedCount = 0;
    const warnings: string[] = [];
    const failures: ExtractFailureTally = new Map(); // 실패 사유 → 명 수(FX-4)
    setExtractProgress({ current: 0, total: targets.length, currentName: '', status: 'running' });

    for (let i = 0; i < targets.length; i++) {
      // 화면이 내려갔으면 다음 환자의 추출을 부르지 않는다(완료 알림도 띄우지 않는다).
      if (!isAlive()) return;
      const p = targets[i];
      setExtractProgress({ current: i + 1, total: targets.length, currentName: p.data.shared.name || p.data.shared.patientNo, status: 'running' });

      const hadInjuryDate = !!p.data.shared.injuryDate;
      const patientLabel = p.data.shared.name || p.data.shared.patientNo;
      // 요청 당시 식별정보 — 적용 시점에 이것과 다르면(그사이 등록번호·재해일자 변경, 삭제) 결과를 섞지 않는다.
      const requested = { patientNo: p.data.shared.patientNo, injuryDate: p.data.shared.injuryDate || '' };

      try {
        // 브리지·extractRecord는 함수 첫 줄에서 확인했다(! — 다시 묻지 않는 지금 동작 그대로).
        const result: EmrExtractRecordResult = await getEmrBridge()!.extractRecord!(p.data.shared.patientNo, p.data.shared.injuryDate || '');
        if (!isAlive()) return;
        if (result.success) {
          // patientNo 교차검증: EMR이 다른 환자 데이터를 반환한 경우 skip
          if (result.patientNo && result.patientNo !== p.data.shared.patientNo) {
            failCount++;
            addExtractFailure(failures, EXTRACT_FAILURE_PATIENT_MISMATCH);
            continue;
          }
          // 새 상병 후보의 id는 전이 밖에서 미리 만든다 — 전이(updater)는 StrictMode에서 두 번 돌 수 있어 순수해야 한다.
          const diseaseCandidates = (result.diseases || [])
            .filter(d => d.code)
            .map(d => ({ id: crypto.randomUUID(), code: d.code, name: d.name, side: '' }));
          // 적용 시점의 최신 shared에 병합(P2-39b): 추출 값은 옮기기 전처럼 덮어쓰고, 추출이 건드리지 않는 필드와
          // 기다리는 동안 추가된 상병은 그대로 둔다. 상병은 적용 시점 목록 기준으로 코드 중복을 뺀다.
          const patch = (current: SharedData): SharedData => {
            const updated = { ...current };
            if (result.patientName) updated.name = result.patientName;
            if (result.birthDate) updated.birthDate = result.birthDate;
            if (result.gender) updated.gender = result.gender;
            // 재해일자: 사용자가 입력하지 않은 경우에만 자동 채움(요청 때 비어 있었음 = 적용 시점에도 비어 있음이 식별 검사로 보장).
            if (!hadInjuryDate && result.accidentDate) updated.injuryDate = result.accidentDate;
            if (result.medicalRecord) updated.medicalRecord = result.medicalRecord;
            if (result.highBloodPressure) updated.highBloodPressure = result.highBloodPressure;
            if (result.diabetes) updated.diabetes = result.diabetes;
            if (result.visitHistory) updated.visitHistory = result.visitHistory;
            if (diseaseCandidates.length > 0) {
              const existingCodes = new Set((updated.diagnoses || []).map(d => d.code).filter(Boolean));
              const diseasesToAdd = diseaseCandidates.filter(d => !existingCodes.has(d.code));
              if (diseasesToAdd.length > 0) updated.diagnoses = [...(updated.diagnoses || []), ...diseasesToAdd];
            }
            return updated;
          };

          // 적용 여부는 커밋 뒤 전이의 판정으로 — 그사이 등록번호·재해일자가 바뀌었거나 삭제됐으면 건너뜀.
          const applied = await applySharedPatch({ id: p.id, requested, patch, session });
          if (!applied) {
            skippedCount++;
            warnings.push(`${patientLabel}: 추출 중 환자 정보가 바뀌어 건너뜀`);
            continue;
          }
          successCount++;
          // 재해일자별 신청건 매칭 결과 경고 누적
          if (!hadInjuryDate && result.multipleEntries) {
            warnings.push(`${patientLabel}: 재해일자가 다른 신청건이 있습니다 (1번 항목을 불러왔습니다)`);
          }
          if (hadInjuryDate && result.injuryDateMismatch) {
            warnings.push(`${patientLabel}: 일치하는 재해일자의 신청건이 없어 1번 항목을 불러왔습니다`);
          }
        } else {
          failCount++;
          addExtractFailure(failures, extractFailureReason(result));
        }
      } catch {
        failCount++;
        addExtractFailure(failures, EXTRACT_FAILURE_EXCEPTION);
      }
    }

    if (!isAlive()) return;
    setExtractProgress(null);
    let doneMsg = `EMR 추출 완료: ${targets.length}명 중 성공 ${successCount}명, 실패 ${failCount}명`;
    if (skippedCount > 0) doneMsg += `, 건너뜀 ${skippedCount}명`;
    // 실패 사유(FX-4) — 많이 나온 순 3가지까지 + 그 밖. 실패가 없으면 줄을 더하지 않는다(문구는 전과 같음).
    const failureLines = formatExtractFailures(failures);
    if (failureLines.length > 0) doneMsg += `\n${failureLines.join('\n')}`;
    if (warnings.length > 0) {
      doneMsg += `\n\n⚠ 확인 필요:\n${warnings.join('\n')}`;
    }
    await alertAlive(doneMsg);
  };

  // 다학제회신 추출 (현재 환자, 진료메인 페이지 대상)
  const handleExtractConsultation = async (): Promise<void> => {
    if (!getEmrBridge()?.extractConsultation) return;
    try {
      // 브리지·extractConsultation은 함수 첫 줄에서 확인했다(! — 다시 묻지 않는 지금 동작 그대로).
      const result: EmrConsultationResult = await getEmrBridge()!.extractConsultation!();
      if (!isAlive()) return;
      if (result.success && result.consultations) {
        // 환자 식별 확인: EMR 진료메인 화면의 환자와 앱의 현재 환자가 일치하는지 사용자에게 확인
        // activePatient는 가드가 없다(! — 없으면 지금처럼 예외 → catch → 오류 알림).
        const patientLabel = (activePatient!.data as PatientData).shared.name
          ? `${(activePatient!.data as PatientData).shared.name}(${(activePatient!.data as PatientData).shared.patientNo || ''})`
          : (activePatient!.data as PatientData).shared.patientNo || '현재 환자';
        const confirmed = await confirmAlive(
          `EMR 화면의 다학제 회신 ${result.consultations.length}건을 [${patientLabel}]에게 저장합니다.\nEMR 진료메인 화면이 이 환자의 화면인지 확인해주세요.`
        );
        if (!confirmed) return;

        // 확인창을 띄운 시점의 환자(등록번호) — 확인하는 동안 바뀌었으면 저장하지 않는다(P2-39b). activePatient는 위와 같이 !.
        const requested = { patientNo: (activePatient!.data as PatientData).shared.patientNo || '' };
        // 회신은 적용 시점의 최신 값 뒤에 덧붙인다(기다리는 동안 직접 쓴 회신·다른 필드 보존).
        const patch = (current: SharedData): SharedData => {
          const updated = { ...current };
          const appendReply = (key: ConsultReplyKey, content: string): void => {
            updated[key] = updated[key] ? updated[key] + '\n---\n' + content : content;
          };
          for (const c of result.consultations) {
            if (c.department === '정형외과') appendReply('consultReplyOrtho', c.content);
            else if (c.department === '신경외과') appendReply('consultReplyNeuro', c.content);
            else if (c.department === '재활의학과') appendReply('consultReplyRehab', c.content);
            else appendReply('consultReplyOther', c.content);
          }
          return updated;
        };
        // 적용 여부는 커밋 뒤 전이의 판정으로(확인하는 동안 등록번호가 바뀌었거나 삭제됐으면 저장하지 않음). activePatient는 위와 같이 !.
        const applied = await applySharedPatch({ id: activePatient!.id, requested, patch, session });
        if (!applied) {
          await alertAlive('다학제 회신을 저장하지 않았습니다 — 확인하는 동안 환자 정보가 바뀌어(등록번호 변경 또는 삭제) 다른 환자에 저장될 수 있습니다. 다시 추출해 주세요.');
          return;
        }
        await alertAlive(`${result.consultations.length}개 과목 회신을 가져왔습니다.`);
      } else {
        await alertAlive(`다학제회신 추출 실패: ${result.error || result.message || '알 수 없는 오류'}`);
      }
    } catch (err) {
      await alertAlive('다학제회신 추출 오류: ' + (err as Error).message);
    }
  };

  return {
    extractProgress,
    setExtractProgress,
    handleInjectEMR,
    handleInjectConsultReply,
    handleEmrExtractBatch,
    handleExtractConsultation,
  };
}
