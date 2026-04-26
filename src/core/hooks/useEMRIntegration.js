import { useState } from 'react';
import { showAlert, showConfirm } from '../utils/platform';
import { touchPatientRecord } from '../services/patientRecords';

export function useEMRIntegration({ activePatient, patients, selectedIds, session, setPatients }) {
  const [extractProgress, setExtractProgress] = useState(null);

  const handleInjectEMR = async () => {
    if (!activePatient || !window.electron?.injectEMR) return;
    const ok = await showConfirm('EMR 소견서에 현재 환자 데이터를 직접 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { generateEMRFieldData } = await import('../utils/exportService');
      const fieldData = generateEMRFieldData(activePatient);
      const result = await window.electron.injectEMR(fieldData);
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
    if (!activePatient || !window.electron?.injectEMR) return;
    const ok = await showConfirm('다학제 회신 내용을 EMR 종합소견 2,3번 칸에 입력합니다.\nEMR 업무관련성 특별진찰소견서가 열려있는지 확인하세요.\n\n계속하시겠습니까?');
    if (!ok) return;
    try {
      const { generateConsultReplyFieldData } = await import('../utils/exportService');
      const fieldData = generateConsultReplyFieldData(activePatient);
      const result = await window.electron.injectEMR(fieldData);
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
    if (!window.electron?.extractRecord) return;
    const targets = selectedIds.size > 0
      ? patients.filter(p => selectedIds.has(p.id) && p.data?.shared?.patientNo)
      : (activePatient?.data?.shared?.patientNo ? [activePatient] : []);
    if (targets.length === 0) {
      await showAlert('선택된 환자 중 환자등록번호가 입력된 환자가 없습니다.');
      return;
    }
    const ok = await showConfirm(`${targets.length}명의 환자 데이터를 EMR에서 추출합니다.\n진료기록분석지 페이지가 열려있는지 확인하세요.\n\n계속하시겠습니까?`);
    if (!ok) return;

    let successCount = 0, failCount = 0;
    setExtractProgress({ current: 0, total: targets.length, currentName: '', status: 'running' });

    for (let i = 0; i < targets.length; i++) {
      const p = targets[i];
      setExtractProgress({ current: i + 1, total: targets.length, currentName: p.data.shared.name || p.data.shared.patientNo, status: 'running' });

      try {
        const result = await window.electron.extractRecord(p.data.shared.patientNo);
        if (result.success) {
          // patientNo 교차검증: EMR이 다른 환자 데이터를 반환한 경우 skip
          if (result.patientNo && result.patientNo !== p.data.shared.patientNo) {
            failCount++;
            continue;
          }
          successCount++;
          const updated = { ...p.data.shared };
          if (result.patientName) updated.name = result.patientName;
          if (result.birthDate) updated.birthDate = result.birthDate;
          if (result.accidentDate) updated.injuryDate = result.accidentDate;
          if (result.medicalRecord) updated.medicalRecord = result.medicalRecord;
          if (result.highBloodPressure) updated.highBloodPressure = result.highBloodPressure;
          if (result.diabetes) updated.diabetes = result.diabetes;
          if (result.visitHistory) updated.visitHistory = result.visitHistory;

          if (result.diseases?.length > 0) {
            const existingCodes = new Set((updated.diagnoses || []).map(d => d.code).filter(Boolean));
            const newDiseases = result.diseases.filter(d => d.code && !existingCodes.has(d.code));
            if (newDiseases.length > 0) {
              const diseasesToAdd = newDiseases.map(d => ({
                id: crypto.randomUUID(),
                code: d.code,
                name: d.name,
                side: ''
              }));
              updated.diagnoses = [...(updated.diagnoses || []), ...diseasesToAdd];
            }
          }

          setPatients(prev => prev.map(pt =>
            pt.id === p.id
              ? touchPatientRecord(
                  { ...pt, updatedAt: new Date().toISOString(), data: { ...pt.data, shared: updated } },
                  { session }
                )
              : pt
          ));
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    setExtractProgress(null);
    await showAlert(`EMR 추출 완료: ${targets.length}명 중 성공 ${successCount}명, 실패 ${failCount}명`);
  };

  // 다학제회신 추출 (현재 환자, 진료메인 페이지 대상)
  const handleExtractConsultation = async () => {
    if (!window.electron?.extractConsultation) return;
    try {
      const result = await window.electron.extractConsultation();
      if (result.success && result.consultations) {
        // 환자 식별 확인: EMR 진료메인 화면의 환자와 앱의 현재 환자가 일치하는지 사용자에게 확인
        const patientLabel = activePatient.data.shared.name
          ? `${activePatient.data.shared.name}(${activePatient.data.shared.patientNo || ''})`
          : activePatient.data.shared.patientNo || '현재 환자';
        const confirmed = await showConfirm(
          `EMR 화면의 다학제 회신 ${result.consultations.length}건을 [${patientLabel}]에게 저장합니다.\nEMR 진료메인 화면이 이 환자의 화면인지 확인해주세요.`
        );
        if (!confirmed) return;

        const updated = { ...activePatient.data.shared };
        const appendReply = (key, content) => {
          updated[key] = updated[key] ? updated[key] + '\n---\n' + content : content;
        };
        for (const c of result.consultations) {
          if (c.department === '정형외과') appendReply('consultReplyOrtho', c.content);
          else if (c.department === '신경외과') appendReply('consultReplyNeuro', c.content);
          else if (c.department === '재활의학과') appendReply('consultReplyRehab', c.content);
          else appendReply('consultReplyOther', c.content);
        }
        setPatients(prev => prev.map(p =>
          p.id === activePatient.id
            ? touchPatientRecord(
                { ...p, updatedAt: new Date().toISOString(), data: { ...p.data, shared: updated } },
                { session }
              )
            : p
        ));
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
