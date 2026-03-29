function formatCheckedAt(value) {
  if (!value) return '';

  try {
    return new Date(value).toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '';
  }
}

function getStatusCopy(status) {
  if (status?.connectivity === 'fallback') {
    return {
      tone: 'fallback',
      title: '로컬 폴백',
      detail: status.lastError || status.message,
    };
  }

  if (status?.connectivity === 'connected' && status?.mock) {
    return {
      tone: 'mock',
      title: 'Mock intranet 연결',
      detail: status.baseUrl || 'Remote mock endpoint',
    };
  }

  if (status?.connectivity === 'connected') {
    return {
      tone: 'connected',
      title: 'Intranet 연결',
      detail: status.baseUrl || 'Remote endpoint connected',
    };
  }

  if (status?.connectivity === 'checking') {
    return {
      tone: 'checking',
      title: '서버 확인 중',
      detail: status.baseUrl || '/api',
    };
  }

  return {
    tone: 'local',
    title: '로컬 저장',
    detail: '이 기기에만 저장',
  };
}

export function IntegrationStatusBadge({ status }) {
  const copy = getStatusCopy(status);
  const checkedAt = formatCheckedAt(status?.lastCheckedAt);

  return (
    <div className={`integration-status integration-status-${copy.tone}`}>
      <div className="integration-status-title-row">
        <span className="integration-status-pill">{copy.title}</span>
        {checkedAt && <span className="integration-status-time">확인 {checkedAt}</span>}
      </div>
      <div className="integration-status-detail">{copy.detail}</div>
    </div>
  );
}
