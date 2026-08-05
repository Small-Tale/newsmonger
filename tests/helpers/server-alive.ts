/**
 * "Did the E2E server go away?" — the sentence that replaces a mystery
 * (NEWS-298).
 *
 * The suite is `workers: 1`, one shared server, one data dir, and specs that
 * deliberately build on each other's state. That trade buys realistic multi-step
 * flows and is not the thing to undo. Its cost is diagnosis: when the *server*
 * dies partway through a file, every later assertion in that file is testing
 * nothing, and the failure Playwright reports is whichever assertion happened to
 * come next.
 *
 * That is not hypothetical. During NEWS-280/281 a sibling worktree's teardown
 * killed the shared server and the visible result was a **NEWS-238 dirty-select
 * assertion failing** — a feature nobody had touched. The hours went into
 * investigating the wrong feature; the actual fix (NEWS-287's derived port) had
 * nothing to do with any assertion that failed.
 *
 * So this is deliberately not a fix for the cascade. It is a *label* on it: one
 * probe, run only when a test has already failed, that answers whether the run
 * is void. Pure and dependency-injected so the wording — the whole point — can
 * be asserted without killing a real server.
 */

/** The verdict, and what a reader should do about it. */
export interface AliveVerdict {
  alive: boolean;
  /** Empty when the server answered. Otherwise the sentence to print. */
  message: string;
}

/** Minimal shape of what a probe returns; `fetch` and Playwright both fit. */
export interface ProbeResult {
  ok: boolean;
  status: number;
}

export interface AliveDeps {
  /** Resolve with the response, or reject when the connection fails. */
  probe: (url: string) => Promise<ProbeResult>;
}

/**
 * The banner a reader sees. Kept in one place because **the wording is the
 * deliverable** — a future edit that softens it back into "request failed"
 * regresses the whole ticket without failing anything.
 */
export function voidRunMessage(url: string, detail: string): string {
  return [
    '',
    '='.repeat(78),
    'THE E2E SERVER WENT AWAY — THIS RUN IS VOID.',
    '',
    `  ${url} did not answer: ${detail}`,
    '',
    '  Every later failure in this file is a consequence, not a cause. The suite',
    '  shares one server and its specs build on each other, so once the server is',
    '  gone the remaining assertions are testing nothing. Do not debug them.',
    '',
    '  Likely causes: another checkout running the suite (NEWS-287 derives a port',
    '  per checkout — check `tests/helpers/e2e-port.ts`), a crashed server left by',
    '  an earlier run, or the machine sleeping mid-run.',
    '='.repeat(78),
    '',
  ].join('\n');
}

/**
 * Probe the server, once.
 *
 * Never throws: it is called from a failure path, and a diagnostic that fails
 * turns one confusing failure into two. A non-2xx answer still counts as
 * **alive** — the process is up and talking, so whatever failed is a real
 * finding rather than a dead run.
 */
export async function serverAlive(baseURL: string, deps: AliveDeps): Promise<AliveVerdict> {
  const url = `${baseURL.replace(/\/$/, '')}/healthz`;
  try {
    const res = await deps.probe(url);
    if (res.ok) return { alive: true, message: '' };
    // Up but unhealthy. Worth saying, and worth *not* calling void: the run's
    // later failures may still be real.
    return { alive: true, message: `note: ${url} answered ${String(res.status)} rather than 200` };
  } catch (err) {
    // First line only. Playwright's request errors carry a multi-line call log
    // (headers, redirects), and pasting it into the middle of the banner pushes
    // the two sentences that matter — "consequence, not a cause", "do not debug
    // them" — off the bottom of a terminal. The full error is in the trace.
    const detail = (err instanceof Error ? err.message : String(err)).split('\n')[0].trim();
    return { alive: false, message: voidRunMessage(url, detail) };
  }
}
