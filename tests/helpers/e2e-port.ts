import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The E2E servers' ports, derived per checkout (NEWS-287).
 *
 * **Why this exists.** The port was the constant `4189`, so two checkouts of
 * this repo could not run E2E at the same time — two worktrees, two agents, or a
 * developer running the suite while an agent did. That cost three failed gate
 * runs during the NEWS-280/281 work, and the expensive part was not the
 * collision itself but *where it surfaced*:
 *
 * - one run died on `http://127.0.0.1:4189/healthz is already used`, before a
 *   single test ran;
 * - a sibling worktree's run died on `ECONNREFUSED` mid-file, because the other
 *   run's Playwright teardown killed the server out from under it;
 * - and that took a NEWS-238 assertion down with it. The specs build on each
 *   other's state, so losing the server mid-file corrupts later assertions in
 *   the same file, and the failure reads as a regression in an unrelated
 *   feature.
 *
 * **Hashed from the checkout path, not the pid.** The data dir is pid-scoped
 * (`playwright.config.ts`) because it wants to be *fresh* every run; a port
 * wants the opposite. Stability per checkout is what makes it possible to say
 * "this port is held, and it can only be this checkout" — which is what turns a
 * squatting server from a crashed run into a diagnosable, cleanable thing rather
 * than a mystery (see `scripts/e2e-preflight.mjs`). A pid-derived port would
 * wander into an unrelated program's territory on a long-running machine and be
 * unrecognisable when it did.
 */

/** The first port this scheme hands out — clear of the app's own default, 4187. */
export const PORT_RANGE_START = 4200;

/**
 * How many distinct windows the scheme can hand out.
 *
 * 400, which puts the whole range in 4200–4999 — near the app's own port, so a
 * stray listener is recognisably ours, and clear of 5000 (which macOS itself
 * takes for AirPlay Receiver) and of the 5432/5900/6379 neighbourhood.
 *
 * A hash over 400 slots is not injective, and pretending otherwise would be the
 * dishonest part. Two checkouts collide with probability ~1/400 per pair, so with
 * the two or three worktrees this repo actually runs it is well under a percent —
 * and when it happens `scripts/e2e-preflight.mjs` says so in a sentence instead of
 * leaving a raw `ECONNREFUSED` in an unrelated spec. That is the trade: a small
 * residual chance of a *diagnosed* collision, in place of a certain undiagnosable
 * one.
 */
export const PORT_SLOTS = 400;

/**
 * Ports reserved per checkout.
 *
 * Reserved as a *window* rather than handed out one at a time, so a second
 * server in one checkout can never land on another checkout's first. With one
 * port each and a `+1` for the second server, checkout A's real-provider port
 * would be checkout B's shared port whenever their slots were adjacent — a
 * collision introduced by the very scheme meant to prevent them.
 */
export const PORTS_PER_CHECKOUT = 2;

/** The shared `--ai-test` server every spec but one talks to. */
export const E2E_SERVER = 0;

/** The real-subscription spec's own server (NEWS-276) — `npm run test:e2e:real`. */
export const E2E_REAL_SERVER = 1;

/** This checkout's root, resolved from this module rather than from `cwd`. */
export const CHECKOUT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The port a given checkout uses for a given server role.
 *
 * Deterministic: the same path always yields the same port, and paths that
 * differ only in trailing separators or `.` segments are the same checkout.
 *
 * @param checkoutPath - Absolute path to a repo checkout.
 * @param role - `E2E_SERVER` or `E2E_REAL_SERVER`.
 */
export function e2ePortFor(checkoutPath: string, role: number = E2E_SERVER): number {
  const digest = crypto.createHash('sha256').update(path.resolve(checkoutPath)).digest();
  const slot = digest.readUInt32BE(0) % PORT_SLOTS;
  return PORT_RANGE_START + slot * PORTS_PER_CHECKOUT + role;
}

/**
 * The port *this* checkout uses for a given server role.
 *
 * @param role - `E2E_SERVER` or `E2E_REAL_SERVER`.
 */
export function e2ePort(role: number = E2E_SERVER): number {
  return e2ePortFor(CHECKOUT_ROOT, role);
}
