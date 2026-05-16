import { useEffect, useState } from 'react';
import { requestJson } from '../services/httpClient';

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
  const [opsStatus, setOpsStatus] = useState(null);

  useEffect(() => {
    if (!enabled) return;

    const baseUrl = session?.apiBaseUrl || '';
    let cancelled = false;

    const poll = async () => {
      try {
        const data = await requestJson('/api/admin/ops/backup-status', { baseUrl, session });
        if (!cancelled) setOpsStatus(data);
      } catch {
        // Best-effort: silently ignore network/auth errors.
        // The ops banner is an enhancement, not a critical path.
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [enabled, session]);

  const summary = opsStatus?.monitorReport?.summary ?? null;
  const showBanner = enabled && WARN_SUMMARIES.has(summary);
  const bannerMessage = showBanner ? BANNER_MESSAGES[summary] : null;

  return { opsStatus, showBanner, bannerMessage };
}
