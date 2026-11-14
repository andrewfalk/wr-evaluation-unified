import { useEffect } from 'react';
import { requestJson } from '../services/httpClient';
import { resolveApiBaseUrl } from '../../platform/dataMode';
import { useAsync } from './useAsync';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Summary values that represent real operational problems (not dry-run test artifacts).
const WARN_SUMMARIES = new Set(['stale', 'alert_open', 'stale_and_alert']);

const BANNER_MESSAGES = {
  stale:
    '\uBC31\uC5C5 \uC131\uACF5 \uAE30\uB85D\uC774 \uC5C6\uAC70\uB098 \uC9C0\uC5F0\uB418\uC5C8\uC2B5\uB2C8\uB2E4 - \uC2E4\uC81C \uBC31\uC5C5\uC744 1\uD68C \uC2E4\uD589\uD558\uACE0 \uC6B4\uC601 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694',
  alert_open:
    '\uBC31\uC5C5 \uC2E4\uD328 \uC54C\uB9BC\uC774 \uBBF8\uCC98\uB9AC \uC0C1\uD0DC\uC785\uB2C8\uB2E4 - \uAD00\uB9AC\uC790 \uCF58\uC194 > \uC6B4\uC601 \uC0C1\uD0DC \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694',
  stale_and_alert:
    '\uBC31\uC5C5 \uC9C0\uC5F0\uACFC \uC2E4\uD328 \uC54C\uB9BC\uC774 \uD568\uAED8 \uAC10\uC9C0\uB418\uC5C8\uC2B5\uB2C8\uB2E4 - \uAD00\uB9AC\uC790 \uCF58\uC194 > \uC6B4\uC601 \uC0C1\uD0DC \uD0ED\uC5D0\uC11C \uD655\uC778\uD558\uC138\uC694',
};

export function useOpsStatus({ session, enabled = false }) {
  // P2-19: 손으로 쓰던 opsStatus state + cancelled 플래그 → useAsync(늦은 응답·언마운트 뒤 응답은 버림).
  // 실패는 조용히 넘어가고 마지막 값을 유지한다(배너는 부가 기능 — 핵심 경로가 아님, 예전과 같음).
  const { data, run, cancel } = useAsync();
  const opsStatus = data ?? null;

  useEffect(() => {
    if (!enabled) return undefined;

    const baseUrl = resolveApiBaseUrl({ session });
    const poll = () => { run(() => requestJson('/api/admin/ops/backup-status', { baseUrl, session })); };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancel(); clearInterval(id); };
  }, [enabled, session, run, cancel]);

  const summary = opsStatus?.monitorReport?.summary ?? null;
  const showBanner = enabled && WARN_SUMMARIES.has(summary);
  const bannerMessage = showBanner ? BANNER_MESSAGES[summary] : null;

  return { opsStatus, showBanner, bannerMessage };
}
