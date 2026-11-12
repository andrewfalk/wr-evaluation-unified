// execFile that a shutdown can stop (S9): on abort the child gets SIGTERM, then SIGKILL if it is still running after
// `killGraceMs`. The promise rejects with the usual execFile error (killed / signal set); callers check the signal to
// tell a shutdown from a failure.
import { execFile, type ChildProcess, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const SHUTDOWN_KILL_GRACE_MS = 5000;

/** The parts of a ChildProcess the escalation needs (a fake in tests). */
export type KillableChild = Pick<ChildProcess, 'kill' | 'exitCode' | 'signalCode'>;

/** SIGTERM now, SIGKILL after `graceMs` unless the child has exited by then. Returns the escalation timer. */
export function terminateWithGrace(child: KillableChild, graceMs: number): NodeJS.Timeout {
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  }, graceMs);
  timer.unref();
  return timer;
}

export class ExecAbortedError extends Error {
  constructor() {
    super('subprocess not started: shutting down');
    this.name = 'ExecAbortedError';
  }
}

export async function execFileAbortable(
  file: string,
  args: string[],
  options: ExecFileOptions,
  signal?: AbortSignal,
  killGraceMs: number = SHUTDOWN_KILL_GRACE_MS,
): Promise<{ stdout: string | Buffer; stderr: string | Buffer }> {
  if (signal?.aborted) throw new ExecAbortedError();
  const running = execFileAsync(file, args, options);
  if (!signal) return running;
  const child = (running as unknown as { child: ChildProcess }).child;
  const onAbort = () => { terminateWithGrace(child, killGraceMs); };
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await running;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}
