import { useEffect, useRef, useState } from 'react';
import { showAlert, showConfirm } from '../utils/platform';
import { patientTx } from '../state/patientStore/transitions';
import { getEmrBridge } from '../../platform/bridge';

export function useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients, dirtyAssessmentPatientId }) {
  // 커밋 배리어(P2-39b, #323 Codex) — 전이 patient/sharedPatched가 적용 시점 목록으로 적용했는지(receipt)는 커밋 뒤에야
  // 확정된다. 미리 렌더된 목록으로 판정하면 같은 배치에 들어온 식별정보 변경을 놓쳐 저장하지 않은 결과를 성공으로 알린다.
  // 전이와 tick을 같은 동기 구간에서 예약하고, tick이 반영된 커밋의 effect에서 기다리던 쪽을 깨운다(usePatientSync outcomeTick과 같은 방식).
  const [commitTick, setCommitTick] = useState(0);
  const commitWaitersRef = useRef([]);
  useEffect(() => {
    if (commitWaitersRef.current.length === 0) return;
    commitWaitersRef.current.splice(0).forEach(resolve => resolve());
  }, [commitTick]);
  // 언마운트 시 기다리던 쪽을 놓아준다(무한 대기 방지).
  useEffect(() => () => { commitWaitersRef.current.splice(0).forEach(resolve => resolve()); }, []);
  const applySharedPatch = (payload) => {
    const receipt = { applied: undefined };
    const committed = new Promise(resolve => { commitWaitersRef.current.push(resolve); });
    setPatients(patientTx.sharedPatched({ ...payload, receipt }));
    setCommitTick(t => t + 1);
    return committed.then(() => receipt.applied === true);
  };
  const [extractProgress, setExtractProgress] = useState(null);

  const handleInjectEMR = async () => {
    if (!activePatient || !getEmrBridge()?.injectEMR) return;
    if (dirtyAssessmentPatientId === activePatient.id) {
      await showAlert('저장하지 않은 종합소견 편집 내용이 있습니다.\n"편집 완료"로 저장한 뒤 다시 시도하세요.');
      return;
    }
    const ok = await showConfirm('EMR 소견서에 현재 환자 데이터를 직접 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { prepareEmrInjection } = await import('../utils/emrReport');
      const { EMR_TEXT_LIMIT_BYTES } = await import('../utils/emrText');

      const { fieldData, effective, bytes, confirmedDx } = prepareEmrInjection(activePatient);

      if (effective.hasInvalidOverride) {
        await showAlert('저장된 종합소견 편집 데이터가 손상되어 전송할 수 없습니다.\n종합평가 화면에서 "깨진 편집 데이터 삭제" 후 다시 시도하세요.');
        return;
      }
      // isStale은 오버라이드가 유효할 때만 true(resolveAssessment) — 차단하지 않고 전송
      // 직전에 한 번 더 확인만 한다(정책: 화면 경고 배너 + 전송 직전 재확인).
      if (effective.isStale) {
        const proceedStale = await showConfirm(
          '⚠ 직접 편집한 종합소견 이후 상병·직업·평가 데이터가 변경되었습니다.\n'
          + '전송될 내용은 편집 시점 그대로이며 최신 데이터와 다를 수 있습니다.\n\n'
          + '편집본을 그대로 전송하시겠습니까?'
        );
        if (!proceedStale) return;
      }
      // 전송 전 경고(종합소견 한도 초과 · 확인 상병 0건/한도 초과)는 사유를 모아 확인창 한 번으로
      // 묻는다. 확인 상병 판정은 절단 전 원본 b5 기준(confirmedDx) — 이미 절단된
      // fieldData.txtAppvSickCont 길이로는 초과를 알 수 없다. EMR 헬퍼는 빈 값이면 칸을 건드리지
      // 않으므로(SetField early-return), 0건이면 EMR에 이미 들어 있던 값이 그대로 남는다.
      const warnings = [];
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
        const proceed = await showConfirm(
          warnings.join('\n\n') + '\n\n' + (willTruncate ? '잘린 상태로 계속 전송하시겠습니까?' : '계속 전송하시겠습니까?')
        );
        if (!proceed) return;
      }

      const result = await getEmrBridge().injectEMR({ ...fieldData, _source: effective.isOverride ? 'edited' : 'auto' });
      if (result.success) {
        let msg = `${result.message}`;
        if (result.truncatedFields?.length > 0) {
          msg += `\n\n⚠ 길이 제한으로 잘린 필드: ${result.truncatedFields.join(', ')}`;
        }
        if (result.failedFields?.length > 0) {
          msg += `\n\n일부 실패:\n${result.failedFields.map(f => `- ${f.field}: ${f.reason}`).join('\n')}`;
        }
        await showAlert(msg);
      } else {
        await showAlert(`EMR 입력 실패: ${result.message}`);
      }
    } catch (err) { await showAlert('EMR 입력 오류: ' + err.message); }
  };

  const handleInjectConsultReply = async () => {
    if (!activePatient || !getEmrBridge()?.injectEMR) return;
    const ok = await showConfirm('다학제 회신 내용을 EMR 종합소견 2,3번 칸에 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { generateConsultReplyFieldData } = await import('../utils/exportService');
      const fieldData = generateConsultReplyFieldData(activePatient);
      const result = await getEmrBridge().injectEMR(fieldData);
      if (result.success) {
        let msg = `${result.message}`;
        if (result.truncatedFields?.length > 0) {
          msg += `\n\n⚠ 길이 제한으로 잘린 필드: ${result.truncatedFields.join(', ')}`;
        }
        if (result.failedFields?.length > 0) {
          msg += `\n\n일부 실패:\n${result.failedFields.map(f => `- ${f.field}: ${f.reason}`).join('\n')}`;
        }
        await showAlert(msg);
      } else {
        await showAlert(`다학제 회신 입력 실패: ${result.message}`);
      }
    } catch (err) { await showAlert('다학제 회신 입력 오류: ' + err.message); }
  };

  // EMR 데이터 일괄 추출 (선택된 환자들의 patientNo 기반)
  const handleEmrExtractBatch = async () => {
    if (!getEmrBridge()?.extractRecord) return;
    const targets = selectedIds.size > 0
      ? patients.filter(p => selectedIds.has(p.id) && p.data?.shared?.patientNo)
      : (activePatient?.data?.shared?.patientNo ? [activePatient] : []);
    if (targets.length === 0) {
      await showAlert('선택된 환자 중 환자등록번호가 입력된 환자가 없습니다.');
      return;
    }
    const ok = await showConfirm(`${targets.length}명의 환자 데이터를 EMR에서 추출합니다.\n진료기록분석지 페이지가 열려있는지 확인하세요.\n\n계속하시겠습니까?`);
    if (!ok) return;

    let successCount = 0, failCount = 0, skippedCount = 0;
    const warnings = [];
    setExtractProgress({ current: 0, total: targets.length, currentName: '', status: 'running' });

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setExtractProgress({ current: i + 1, total: targets.length, currentName: p.data.shared.name || p.data.shared.patientNo, status: 'running' });

      const hadInjuryDate = !!p.data.shared.injuryDate;
      const patientLabel = p.data.shared.name || p.data.shared.patientNo;
      // 요청 당시 식별정보 — 적용 시점에 이것과 다르면(그사이 등록번호·재해일자 변경, 삭제) 결과를 섞지 않는다.
      const requested = { patientNo: p.data.shared.patientNo, injuryDate: p.data.shared.injuryDate || '' };

      try {
        const result = await getEmrBridge().extractRecord(p.data.shared.patientNo, p.data.shared.injuryDate || '');
        if (result.success) {
          // patientNo 교차검증: EMR이 다른 환자 데이터를 반환한 경우 skip
          if (result.patientNo && result.patientNo !== p.data.shared.patientNo) {
            failCount++;
            continue;
          }
          // 새 상병 후보의 id는 전이 밖에서 미리 만든다 — 전이(updater)는 StrictMode에서 두 번 돌 수 있어 순수해야 한다.
          const diseaseCandidates = (result.diseases || [])
            .filter(d => d.code)
            .map(d => ({ id: crypto.randomUUID(), code: d.code, name: d.name, side: '' }));
          // 적용 시점의 최신 shared에 병합(P2-39b): 추출 값은 옮기기 전처럼 덮어쓰고, 추출이 건드리지 않는 필드와
          // 기다리는 동안 추가된 상병은 그대로 둔다. 상병은 적용 시점 목록 기준으로 코드 중복을 뺀다.
          const patch = (current) => {
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
        }
      } catch {
        failCount++;
      }
    }

    setExtractProgress(null);
    let doneMsg = `EMR 추출 완료: ${targets.length}명 중 성공 ${successCount}명, 실패 ${failCount}명`;
    if (skippedCount > 0) doneMsg += `, 건너뜀 ${skippedCount}명`;
    if (warnings.length > 0) {
      doneMsg += `\n\n⚠ 확인 필요:\n${warnings.join('\n')}`;
    }
    await showAlert(doneMsg);
  };

  // 다학제회신 추출 (현재 환자, 진료메인 페이지 대상)
  const handleExtractConsultation = async () => {
    if (!getEmrBridge()?.extractConsultation) return;
    try {
      const result = await getEmrBridge().extractConsultation();
      if (result.success && result.consultations) {
        // 환자 식별 확인: EMR 진료메인 화면의 환자와 앱의 현재 환자가 일치하는지 사용자에게 확인
        const patientLabel = activePatient.data.shared.name
          ? `${activePatient.data.shared.name}(${activePatient.data.shared.patientNo || ''})`
          : activePatient.data.shared.patientNo || '현재 환자';
        const confirmed = await showConfirm(
          `EMR 화면의 다학제 회신 ${result.consultations.length}건을 [${patientLabel}]에게 저장합니다.\nEMR 진료메인 화면이 이 환자의 화면인지 확인해주세요.`
        );
        if (!confirmed) return;

        // 확인창을 띄운 시점의 환자(등록번호) — 확인하는 동안 바뀌었으면 저장하지 않는다(P2-39b).
        const requested = { patientNo: activePatient.data.shared.patientNo || '' };
        // 회신은 적용 시점의 최신 값 뒤에 덧붙인다(기다리는 동안 직접 쓴 회신·다른 필드 보존).
        const patch = (current) => {
          const updated = { ...current };
          const appendReply = (key, content) => {
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
        // 적용 여부는 커밋 뒤 전이의 판정으로(확인하는 동안 등록번호가 바뀌었거나 삭제됐으면 저장하지 않음).
        const applied = await applySharedPatch({ id: activePatient.id, requested, patch, session });
        if (!applied) {
          await showAlert('다학제 회신을 저장하지 않았습니다 — 확인하는 동안 환자 정보가 바뀌어(등록번호 변경 또는 삭제) 다른 환자에 저장될 수 있습니다. 다시 추출해 주세요.');
          return;
        }
        await showAlert(`${result.consultations.length}개 과목 회신을 가져왔습니다.`);
      } else {
        await showAlert(`다학제회신 추출 실패: ${result.error || result.message || '알 수 없는 오류'}`);
      }
    } catch (err) {
      await showAlert('다학제회신 추출 오류: ' + err.message);
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
