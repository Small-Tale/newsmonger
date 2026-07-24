/**
 * OS keychain access for API keys.
 *
 * Shells out to the platform's own credential tool rather than binding a native
 * module (`keytar`, `@napi-rs/keyring`): no `node-gyp`, no prebuilt binaries to
 * ship per architecture, and it works identically in the Tauri sidecar and in
 * plain `npm run dev`. The desktop bundle stages a plain `node_modules` (see
 * `scripts/build-sidecar.sh`), so a native module would have to match the
 * bundled Node's ABI — a dependency this avoids entirely.
 *
 * | OS      | Backend                    | Tool          |
 * |---------|----------------------------|---------------|
 * | macOS   | Keychain                   | `security`    |
 * | Linux   | Secret Service             | `secret-tool` |
 * | Windows | Credential Manager         | PowerShell P/Invoke over `advapi32` |
 *
 * Secrets avoid argv where the tool allows it — Linux takes the value on stdin,
 * Windows through the environment. macOS is the exception, for a measured
 * reason spelled out at the write itself. Every write is read back before it's
 * reported as saved — which is what caught the Windows read bug described at
 * `runPowerShell`.
 */

import { spawn } from 'node:child_process';

/** Keychain service name; the account is the varying part (see `keyAccount`). */
const SERVICE = 'news';

/** Keychain account for a provider's API key, e.g. `anthropic-api-key`. */
export function keyAccount(provider: string): string {
  return `${provider}-api-key`;
}

/** The Windows Credential Manager target for an `account`. */
export function winTarget(account: string): string {
  return `${SERVICE}-${account}`;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run a PowerShell script.
 *
 * `-EncodedCommand` (base64 UTF-16LE), NOT a script piped to `-Command -`.
 * Measured on Windows 11: a multi-line script fed through stdin runs but
 * produces no output — the `Add-Type` here-string defining the `CredRead` shim
 * silently fails to take effect, so reads returned empty while exiting 0. That
 * shape also sidesteps every quoting question.
 */
async function runPowerShell(script: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { ...(env ? { env } : {}) });
}

/** Run a command, optionally writing `input` to its stdin. Never rejects. */
async function run(
  cmd: string,
  args: string[],
  opts: { input?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(opts.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
      });
    } catch {
      resolve({ status: null, stdout: '', stderr: 'spawn failed' });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (d: string) => (stdout += d));
    child.stderr.on('data', (d: string) => (stderr += d));
    child.on('error', () => {
      resolve({ status: null, stdout, stderr: 'spawn failed' });
    });
    child.on('close', (status) => {
      resolve({ status, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/**
 * PowerShell P/Invoke shim over the Windows Credential Manager API.
 *
 * All three operations go through `advapi32` rather than `cmdkey`. `cmdkey`
 * can't read a password back at all, and — measured on Windows 11 — its write
 * form silently truncates: `cmdkey /pass:$env:SECRET` lets PowerShell split the
 * value at the first space, so a secret containing one is stored incomplete.
 * `CredWrite` takes the string as a marshalled blob, so nothing parses it.
 */
const WIN_CRED_PS = `
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class CredHelper {
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredRead(string t, int type, int f, out IntPtr p);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredWrite(ref CRED c, int flags);
    [DllImport("advapi32", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CredDelete(string t, int type, int f);
    [DllImport("advapi32")]
    static extern void CredFree(IntPtr p);
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct CRED {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
        public int Persist; public int AttributeCount; public IntPtr Attributes;
        public string TargetAlias; public string UserName;
    }
    public static string Read(string target) {
        IntPtr ptr;
        if (!CredRead(target, 1, 0, out ptr)) return "";
        CRED c = (CRED)Marshal.PtrToStructure(ptr, typeof(CRED));
        string r = Marshal.PtrToStringUni(c.CredentialBlob, c.CredentialBlobSize / 2);
        CredFree(ptr);
        return r;
    }
    public static bool Write(string target, string user, string secret) {
        byte[] bytes = System.Text.Encoding.Unicode.GetBytes(secret);
        IntPtr blob = Marshal.AllocHGlobal(bytes.Length);
        Marshal.Copy(bytes, 0, blob, bytes.Length);
        CRED c = new CRED();
        c.Type = 1;                       // CRED_TYPE_GENERIC
        c.TargetName = target;
        c.UserName = user;
        c.CredentialBlob = blob;
        c.CredentialBlobSize = bytes.Length;
        c.Persist = 2;                    // CRED_PERSIST_LOCAL_MACHINE
        bool ok = CredWrite(ref c, 0);
        Marshal.FreeHGlobal(blob);
        return ok;
    }
    public static bool Delete(string target) { return CredDelete(target, 1, 0); }
}
'@
`;

/**
 * Read a password on macOS, undoing `security`'s hex encoding.
 *
 * `find-generic-password -w` prints the password literally when it's printable
 * ASCII, but as bare lowercase hex — no `0x`, no marker — when it isn't. Hex
 * output is therefore indistinguishable from a key that simply *looks* like
 * hex, and some providers do issue those; decoding on appearance alone would
 * silently corrupt them. `-g` resolves it, printing `password: 0x...` only for
 * the genuinely-encoded case, so ask it exactly when the value is ambiguous.
 */
async function readMacPassword(account: string): Promise<string | null> {
  const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
  const value = r.stdout.trim();
  if (r.status !== 0 || value === '') return null;

  const looksHex = value.length % 2 === 0 && /^[0-9a-f]+$/.test(value);
  if (!looksHex) return value;

  const g = await run('security', ['find-generic-password', '-s', SERVICE, '-a', account, '-g']);
  return /password:\s*0x/.test(g.stderr) ? Buffer.from(value, 'hex').toString('utf-8') : value;
}

/**
 * In-memory stand-in for the OS keychain, enabled by `NEWS_FAKE_KEYCHAIN=1`.
 *
 * The E2E suite drives real save/remove flows through the UI, and those must
 * not reach into the keychain of whoever runs the tests — leaving entries
 * behind, or triggering an OS authorization prompt that stalls a headless run.
 * Same idea as `--ai-test` for the AI provider: a seam that keeps the test
 * hermetic while exercising every layer above it.
 */
const fakeStore = new Map<string, string>();
function usingFakeKeychain(): boolean {
  return process.env['NEWS_FAKE_KEYCHAIN'] === '1';
}

/** Read a secret. Returns null when absent, or when the keychain is unusable. */
export async function keychainGet(account: string): Promise<string | null> {
  if (usingFakeKeychain()) return fakeStore.get(account) ?? null;
  try {
    if (process.platform === 'darwin') {
      return await readMacPassword(account);
    }

    if (process.platform === 'linux') {
      const r = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
      const value = r.stdout.trim();
      return r.status === 0 && value !== '' ? value : null;
    }

    if (process.platform === 'win32') {
      const target = winTarget(account);
      // Fast existence gate: `cmdkey` is native, whereas the CredRead path spins
      // up PowerShell and compiles a C# shim via `Add-Type` (seconds). "Nothing
      // stored" is the common case, so skip the expensive read entirely.
      // `cmdkey /list:<target>` echoes the target in its header even when
      // nothing is stored, so detect the "* NONE *" marker instead.
      const list = await run('cmdkey', [`/list:${target}`]);
      if (list.status !== 0 || list.stdout.includes('* NONE *')) return null;
      // Base64 of UTF-16, not the raw string. PowerShell writes stdout through
      // the console code page, which mangles anything non-ASCII on the way back
      // — measured on Windows 11: "sk-ümlaut-🔑" arrived as "sk-?mlaut-??".
      // The value itself reaches PowerShell intact (verified byte-for-byte via
      // the environment); it is only the return trip that corrupts it, so the
      // answer is encoded into ASCII before it crosses.
      const r = await runPowerShell(
        `${WIN_CRED_PS}Write-Output ([Convert]::ToBase64String(` +
          `[System.Text.Encoding]::Unicode.GetBytes([CredHelper]::Read($env:NEWS_KC_TARGET))))`,
        { NEWS_KC_TARGET: target },
      );
      if (r.status !== 0) return null;
      const encoded = r.stdout.trim();
      if (encoded === '') return null;
      const value = Buffer.from(encoded, 'base64').toString('utf16le');
      return value !== '' ? value : null;
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Confirm what actually landed in the keychain.
 *
 * A credential tool that exits 0 having stored nothing — or something truncated
 * — would otherwise be reported to the user as a successful save, and only show
 * up later as an authentication failure. Cheap insurance on a rare operation.
 */
async function verifyStored(account: string, expected: string): Promise<void> {
  const stored = await keychainGet(account);
  if (stored !== expected) {
    await keychainDelete(account);
    throw new Error(
      stored === null
        ? 'the key could not be read back after saving'
        : 'the key was altered on the way into the keychain',
    );
  }
}

/** Store a secret. Throws with the tool's own message when the write fails. */
export async function keychainSet(account: string, value: string): Promise<void> {
  if (usingFakeKeychain()) {
    fakeStore.set(account, value);
    return;
  }
  const fail = (label: string, r: RunResult): never => {
    const detail = (r.stderr || r.stdout).trim();
    throw new Error(`${label} failed${detail !== '' ? `: ${detail}` : ''}`);
  };

  if (process.platform === 'darwin') {
    // Delete first — `add-generic-password` refuses to overwrite. A missing
    // entry makes this fail harmlessly, so only the add is checked.
    await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    // The secret goes in argv, which `ps` can see for a few milliseconds. The
    // obvious alternative — `-w` with no value, which prompts and reads the
    // password from stdin — is worse: it caps at 128 characters and silently
    // truncates beyond that (measured). Anthropic keys are ~108 characters and
    // would squeak by, but OpenAI project keys are longer, so that path would
    // store a corrupted key and surface it as a puzzling auth failure. A brief
    // argv exposure on a machine already running the app beats that.
    const r = await run('security', [
      'add-generic-password', '-s', SERVICE, '-a', account, '-U', '-w', value,
    ]);
    if (r.status !== 0) fail('Keychain write', r);
    await verifyStored(account, value);
    return;
  }

  if (process.platform === 'linux') {
    // secret-tool reads the secret from stdin.
    const r = await run('secret-tool', ['store', `--label=${SERVICE}`, 'service', SERVICE, 'account', account], {
      input: value,
    });
    if (r.status !== 0) fail('System keyring write', r);
    await verifyStored(account, value);
    return;
  }

  if (process.platform === 'win32') {
    // The value reaches PowerShell through the environment and is handed to
    // CredWrite as a string — never interpolated into script text, and never
    // an argv element, so nothing splits or quotes it. `Write-Output` reports
    // the API's own success flag, since a failed CredWrite still exits 0.
    const r = await runPowerShell(
      `${WIN_CRED_PS}Write-Output ([CredHelper]::Write($env:NEWS_KC_TARGET, '${SERVICE}', $env:NEWS_KC_SECRET))`,
      { NEWS_KC_TARGET: winTarget(account), NEWS_KC_SECRET: value },
    );
    if (r.status !== 0) fail('Credential Manager write', r);
    if (!r.stdout.includes('True')) fail('Credential Manager write', r);
    await verifyStored(account, value);
    return;
  }

  throw new Error(`No keychain support on ${process.platform}`);
}

/** Remove a secret. Best-effort — a missing entry is not an error. */
export async function keychainDelete(account: string): Promise<void> {
  if (usingFakeKeychain()) {
    fakeStore.delete(account);
    return;
  }
  try {
    if (process.platform === 'darwin') {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', account]);
    } else if (process.platform === 'linux') {
      await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    } else if (process.platform === 'win32') {
      await runPowerShell(`${WIN_CRED_PS}[void][CredHelper]::Delete($env:NEWS_KC_TARGET)`, {
        NEWS_KC_TARGET: winTarget(account),
      });
    }
  } catch {
    /* nothing to remove */
  }
}

/** Probe result, cached for the process lifetime (see `isKeychainAvailable`). */
let availability: Promise<boolean> | null = null;

async function probe(): Promise<boolean> {
  if (usingFakeKeychain()) return true;
  if (process.platform === 'darwin') {
    // `default-keychain` fails when no user keychain exists — e.g. a test run
    // with a temp HOME. Checking first avoids `add-generic-password` popping a
    // system dialog later.
    return (await run('security', ['default-keychain'])).status === 0;
  }

  if (process.platform === 'linux') {
    // `which secret-tool` is not enough: the binary can be installed with no
    // Secret Service daemon running or unlocked, and the failure would surface
    // as a mysterious write error. Verify with a real round-trip on a
    // throwaway entry.
    const account = 'availability-probe';
    const stored = await run('secret-tool', ['store', '--label=news', 'service', SERVICE, 'account', account], {
      input: 'probe',
    });
    if (stored.status !== 0) return false;
    const read = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', account]);
    await run('secret-tool', ['clear', 'service', SERVICE, 'account', account]);
    return read.status === 0 && read.stdout.trim() === 'probe';
  }

  if (process.platform === 'win32') {
    return (await run('cmdkey', ['/list:news-probe'])).status === 0;
  }

  return false;
}

/**
 * Whether keys can be stored at all. Probed once per process — on Linux the
 * probe is a real write/read/delete cycle, too costly to repeat per request.
 */
export function isKeychainAvailable(): Promise<boolean> {
  return (availability ??= probe());
}

/** Display name for the platform's credential store, for UI copy. */
export function keychainLabel(): string {
  if (usingFakeKeychain()) return 'Test Keychain';
  if (process.platform === 'darwin') return 'Keychain';
  if (process.platform === 'linux') return 'System Keyring';
  if (process.platform === 'win32') return 'Credential Manager';
  return 'system keychain';
}

/** Tests only: forget the memoized availability probe and any fake entries. */
export function __resetKeychainForTests(): void {
  availability = null;
  fakeStore.clear();
}
