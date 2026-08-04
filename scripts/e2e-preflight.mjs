#!/usr/bin/env node
//
// Clear the E2E ports before Playwright asks for them (NEWS-287).
//
// **Why this runs at all.** Playwright's own check on a held port is
// `http://127.0.0.1:PORT/healthz is already used, make sure that nothing is
// running on the port` — true, and useless. It cannot say *what* is running,
// whether it is a leftover from a run that crashed, or whether killing it would
// wreck a colleague's suite. Worse, a run that started against a squatter's
// server and then lost it mid-file fails somewhere other than the cause: the
// specs build on each other's state, so a NEWS-238 assertion goes red for a
// reason that has nothing to do with NEWS-238.
//
// Since NEWS-287 the ports are derived from the checkout path, so a holder on one
// of them is *this* checkout's business and there is a real decision to make:
//
//   free                      -> nothing to do.
//   an orphaned newsmonger    -> a crashed run leaked it. Kill it and continue,
//                                saying so, because the alternative is that one
//                                killed agent poisons every later run.
//   a live newsmonger         -> another run in this checkout is using it. Stop,
//                                and say that in a sentence.
//   something else            -> stop, and say it is not ours.
//
// Reported loudly either way. A pre-flight that quietly did something surprising
// to a running process would be worse than the confusing error it replaces.
//
// Invoked from `playwright.config.ts` at config load — the only point that is
// both before Playwright's own port check and inside the process that is about
// to start the server. Plain `.mjs` run by `node`, deliberately: no tsx, so it
// works inside a command sandbox (NEWS-295).
//
// Usage: node scripts/e2e-preflight.mjs <port> [<port> ...]

import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';

/** `null` when the port is free, otherwise the errno that says why not. */
function probe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => {
      resolve(err.code ?? 'EUNKNOWN');
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => {
        resolve(null);
      });
    });
  });
}

/** True when whatever is on `port` answers `/healthz` the way newsmonger does. */
async function isNewsmonger(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(2000) });
    const body = await res.json();
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * The pid and parent pid listening on `port`, each `null` if undeterminable.
 *
 * One `lsof` call in field mode (`-FpR`), which emits `p<pid>` then `R<ppid>`.
 * The parent matters as much as the pid — it is the whole basis for deciding
 * whether a server is a leftover to reclaim or a live run to keep away from.
 *
 * `lsof` rather than `ps` for the parent, deliberately: inside a command sandbox
 * `ps` is denied ("operation not permitted") while `lsof` is not, and the sandbox
 * is exactly where an agent runs — the case this pre-flight was written for.
 * `ps -o ppid=` is kept as the fallback for a machine with no `lsof`. If neither
 * answers, `parentPid` stays `null` and the decision degrades to "stop and
 * explain", which is safe: it never kills something it could not identify.
 */
function listener(port) {
  let pid = null;
  let ppid = null;
  try {
    const out = execFileSync('lsof', ['-nP', '-FpR', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of out.split('\n')) {
      if (pid === null && line.startsWith('p')) pid = Number(line.slice(1));
      else if (line.startsWith('R')) {
        ppid = Number(line.slice(1));
        break;
      }
    }
  } catch {
    // No lsof, or it refused — fall through to the ps fallback below.
  }
  if (pid !== null && !Number.isInteger(pid)) pid = null;
  if (ppid !== null && !Number.isInteger(ppid)) ppid = null;
  if (pid !== null && ppid === null) {
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const parsed = Number(out.trim());
      if (Number.isInteger(parsed)) ppid = parsed;
    } catch {
      // Neither tool available — leave it unknown and stop rather than guess.
    }
  }
  return { pid: pid !== null && pid > 1 ? pid : null, ppid };
}

/**
 * SIGTERM, then SIGKILL, waiting for the port to actually come free.
 *
 * The signal failing is reported rather than swallowed. `ESRCH` is a success —
 * the process went away between the lookup and here. `EPERM` is not, and it is
 * not hypothetical: a command sandbox denies signalling a process outside it,
 * so an agent can find the leaked server, name it, and still be unable to end
 * it. "Could not signal it: EPERM" is an answer; a bare "would not release the
 * port" would send someone hunting a bug in the server.
 */
async function reclaim(port, pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(pid, signal);
    } catch (err) {
      if (err.code === 'ESRCH') return (await probe(port)) === null;
      console.error(`!! e2e pre-flight: could not send ${signal} to pid ${pid}: ${err.code ?? String(err)}`);
      if (err.code === 'EPERM') {
        console.error(`!! A sandboxed shell cannot signal a process outside its sandbox. Kill pid ${pid} from an unsandboxed shell.`);
        return false;
      }
    }
    for (let i = 0; i < 30; i++) {
      if ((await probe(port)) === null) return true;
      await sleep(100);
    }
  }
  return false;
}

async function clearPort(port) {
  const code = await probe(port);
  if (code === null) return true;
  if (code !== 'EADDRINUSE') {
    console.error(`!! e2e pre-flight: cannot bind 127.0.0.1:${port} (${code}).`);
    return false;
  }

  const { pid, ppid } = listener(port);
  const ours = await isNewsmonger(port);

  if (!ours) {
    console.error(
      `!! e2e pre-flight: port ${port} is held${pid === null ? '' : ` by pid ${pid}`}, and it does not answer /healthz as newsmonger.`,
    );
    console.error(`!! This checkout's E2E port is derived from its path, so nothing of ours should be there.`);
    console.error(`!! Stop that process, or move the checkout, and run again.`);
    return false;
  }

  // Orphaned — its Playwright parent is gone and init adopted it. That is a
  // leaked server from a run that crashed or was killed, and reclaiming it is
  // the whole reason this pre-flight exists.
  if (pid !== null && ppid === 1) {
    console.log(`== e2e pre-flight: reclaiming port ${port} from an orphaned newsmonger server (pid ${pid}) ==`);
    console.log(`   Its Playwright parent is gone, so it is a leftover from a run that died mid-flight.`);
    if (await reclaim(port, pid)) return true;
    console.error(`!! e2e pre-flight: pid ${pid} would not release port ${port}. Kill it by hand and run again.`);
    return false;
  }

  console.error(`!! e2e pre-flight: another checkout is running E2E on port ${port}.`);
  console.error(
    `!! A live newsmonger server${pid === null ? '' : ` (pid ${pid})`} is listening there. Almost certainly another run in this same checkout; failing that, a different checkout whose path hashes to the same window (~1 in 400).`,
  );
  console.error(`!! Wait for it to finish rather than racing it: the loser loses its server mid-file and fails inside an unrelated spec.`);
  return false;
}

const ports = process.argv.slice(2).map(Number);
if (ports.length === 0 || ports.some((p) => !Number.isInteger(p) || p <= 0)) {
  console.error('usage: node scripts/e2e-preflight.mjs <port> [<port> ...]');
  process.exit(2);
}

let ok = true;
for (const port of ports) {
  if (!(await clearPort(port))) ok = false;
}
process.exit(ok ? 0 : 1);
