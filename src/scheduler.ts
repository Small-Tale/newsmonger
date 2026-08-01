import type { CheckRunner } from './checks.js';

const DEFAULT_TICK_MS = 60_000;

/**
 * How often to sweep, from `NEWSMONGER_SCHEDULER_TICK_MS` (NEWS-238).
 *
 * Exists for the E2E suite, which runs every spec against **one** long-lived
 * server. A sweep is a background actor no test asked for: it checks any topic
 * that has never been checked — which is most of the topics a spec creates — at
 * a phase that has nothing to do with the test in progress, and writes stories,
 * runs and failures into the state those tests assert on.
 *
 * That is not a hypothetical. `the flag slot leaves the layout when it is empty`
 * was racing a check for the count badge, and the *failure warning can be
 * dismissed* spec says in its own comment that "a new check would be a new
 * failure, which is the one thing that legitimately brings this banner back" —
 * true of a scheduled check as much as a clicked one, and the spec can only
 * avoid clicking.
 *
 * So the suite sets a tick longer than any run, and every check a test sees is
 * one it asked for. Nothing is lost: no spec asserts on a *scheduled* check, so
 * the sweeps were never coverage — they were unasserted mutation. The scheduler
 * itself is covered by `scheduler.test.ts`, with the clock in hand.
 *
 * Anything unparseable or non-positive falls back to the default rather than
 * throwing: a bad value in the environment should not stop the app from
 * checking news on its normal schedule.
 */
export function schedulerTickMs(raw: string | undefined = process.env['NEWSMONGER_SCHEDULER_TICK_MS']): number {
  const n = Number(raw ?? '');
  return raw !== undefined && raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : DEFAULT_TICK_MS;
}

/**
 * Periodically runs due news checks. Every tick, topics whose last check is
 * older than the configured interval (or that have never been checked) are
 * checked. Ticks never overlap: if a sweep is still running, the tick is
 * skipped.
 *
 * When a sweep takes longer than the interval, it **restarts immediately** on
 * completion instead of waiting for the next tick (NEWS-57): the drain loop
 * keeps calling `checkDue` while each pass still finds work, so the cycle rolls
 * continuously under a backlog and only goes idle (back to the timer) once a
 * pass finds nothing due. No busy-loop when idle — a pass that checks nothing
 * returns 0 and the loop stops; and a just-checked topic can't be due again
 * immediately, since the minimum interval (5 min) dwarfs a check.
 */
export function startScheduler(runner: CheckRunner, tickMs: number = DEFAULT_TICK_MS): () => void {
  let sweeping = false;
  let stopped = false;
  const runSweep = async (): Promise<void> => {
    if (sweeping) return;
    sweeping = true;
    try {
      let checked = 0;
      do {
        checked = await runner.checkDue(new Date());
      } while (checked > 0 && !stopped);
    } catch (err) {
      console.error('newsmonger: scheduled check sweep failed:', err);
    } finally {
      sweeping = false;
    }
  };
  const tick = (): void => {
    void runSweep();
  };
  const handle = setInterval(tick, tickMs);
  // Run one sweep shortly after startup so overdue topics don't wait a full tick.
  const startupHandle = setTimeout(tick, 3_000);
  return () => {
    stopped = true;
    clearInterval(handle);
    clearTimeout(startupHandle);
  };
}
