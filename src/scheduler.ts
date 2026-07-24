import type { CheckRunner } from './checks.js';

const DEFAULT_TICK_MS = 60_000;

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
      console.error('news: scheduled check sweep failed:', err);
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
