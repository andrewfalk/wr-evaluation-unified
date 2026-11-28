// 작업대 공용 — 기능 비가용 오류 판별과 CSV 내려받기. P2-77c에서 StatisticsWorkbench.tsx의 선언을 본문 그대로 옮겼다.

/** 서버 오류 객체에서 이 화면이 읽는 필드(statsRepository가 던지는 오류). */
export interface StatsErrorLike {
  status?: number;
  data?: { code?: string };
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function isFeatureUnavailableError(err: unknown): boolean {
  return (err as StatsErrorLike | null | undefined)?.status === 404 && (err as StatsErrorLike | null | undefined)?.data?.code === 'NOT_FOUND';
}
