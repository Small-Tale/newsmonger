/**
 * Cross-origin guard for the local API (NEWS-86).
 *
 * The server binds to 127.0.0.1, which keeps other *machines* out — it does
 * nothing about the user's own browser. Any page they visit can issue requests
 * to `http://127.0.0.1:4187`; without CORS the page can't read the responses,
 * but `DELETE /api/topics/:id` and `POST /api/check` take effect regardless of
 * whether anyone reads the reply. Checking the `Host` header additionally
 * closes DNS rebinding, where an attacker-controlled name resolves to loopback
 * and so *does* get read access.
 *
 * Scope: this defends against the user's browser being turned against the app
 * by a web page. It is deliberately not authentication — a local process can
 * still call the API (and could read the database directly anyway), and a
 * request with no `Origin` header (curl, the test harness) is allowed through.
 * A browser cannot make a cross-origin request without sending one.
 */

import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from './types.js';

/**
 * Whether a hostname denotes this machine.
 *
 * `.localhost` is included because RFC 6761 reserves the whole TLD for
 * loopback, so such a name cannot be rebound to an attacker's address — which
 * is what Tauri's webview uses for its own origin on Windows and Linux
 * (`http://tauri.localhost`).
 */
export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '[::1]'
  );
}

/**
 * Whether the request's `Host` header names this machine.
 *
 * Reads the host off the request URL rather than the raw header: both
 * `@hono/node-server` and `app.request()` build that URL from the `Host`
 * header, so this sees the same value while also working under the test
 * harness, where no literal header is set.
 */
export function hostAllowed(requestUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  return isLoopbackHostname(parsed.hostname);
}

/**
 * Whether an `Origin` header may act on the app.
 *
 * Absent means the request wasn't made cross-origin by a browser. The literal
 * string `null` is an *opaque* origin (a sandboxed iframe, a `data:` document)
 * and is rejected — it is never this app's own page.
 */
export function originAllowed(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  if (origin === 'null') return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  // macOS Tauri webviews serve themselves from `tauri://localhost`.
  if (parsed.protocol === 'tauri:') return true;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHostname(parsed.hostname);
}

/** Reject any request that a page on another origin could have made. */
export function originGuard(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!hostAllowed(c.req.url) || !originAllowed(c.req.header('origin'))) {
      return c.json({ error: 'forbidden: request did not come from the local app' }, 403);
    }
    await next();
  };
}
