// S9: stopping a subprocess on shutdown — SIGTERM, then SIGKILL only if it is still running after the grace period.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecAbortedError, execFileAbortable, terminateWithGrace, type KillableChild } from '../abortableExec';

afterEach(() => { vi.useRealTimers(); });

function fakeChild(): KillableChild & { signals: string[] } {
  const child = {
    signals: [] as string[],
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn((sig?: NodeJS.Signals | number) => { child.signals.push(String(sig)); return true; }),
  };
  return child as unknown as KillableChild & { signals: string[] };
}

describe('terminateWithGrace', () => {
  it('sends SIGTERM now and SIGKILL after the grace period when the child is still running', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateWithGrace(child, 5000);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(child.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('sends no SIGKILL when the child exited within the grace period', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    terminateWithGrace(child, 5000);
    (child as unknown as { signalCode: string }).signalCode = 'SIGTERM';
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.signals).toEqual(['SIGTERM']);
  });
});

describe('execFileAbortable', () => {
  it('an abort stops a running subprocess: the promise rejects as killed', async () => {
    const ac = new AbortController();
    const started = Date.now();
    const running = execFileAbortable(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {}, ac.signal);
    setTimeout(() => ac.abort(), 200);
    await expect(running).rejects.toMatchObject({ killed: true });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('an already-aborted signal starts nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(execFileAbortable(process.execPath, ['-e', 'process.exit(0)'], {}, ac.signal)).rejects.toBeInstanceOf(ExecAbortedError);
  });

  it('without a signal it is a plain execFile', async () => {
    const { stdout } = await execFileAbortable(process.execPath, ['-e', 'process.stdout.write("ok")'], {});
    expect(String(stdout)).toBe('ok');
  });
});
