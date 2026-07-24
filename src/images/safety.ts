/**
 * Guards for server-side fetching of model-supplied URLs.
 *
 * Article and image URLs come from an AI provider, which means an untrusted
 * party chooses what the server connects to. Fetching those without checks is
 * a server-side request forgery hole: `http://169.254.169.254/` is the cloud
 * metadata endpoint, `http://127.0.0.1:4187/api/...` is this app's own API,
 * and a private-range address reaches whatever else is on the user's LAN.
 *
 * The rule here is deny-by-default: only http(s), only a public-looking host,
 * and no credentials in the URL.
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';

/** Hostnames that never make sense to fetch, whatever they resolve to. */
const BLOCKED_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback']);

/** Suffixes for local/mDNS namespaces that shouldn't leave the machine. */
const BLOCKED_SUFFIXES = ['.local', '.localhost', '.internal', '.home.arpa'];

/**
 * Whether an IP address is one the server must not connect to.
 *
 * Covers loopback, private ranges, link-local (including the cloud metadata
 * address at 169.254.169.254), carrier-grade NAT, and the IPv6 equivalents.
 */
export function isBlockedAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 0) return true; // not an address at all — refuse

  if (version === 4) {
    const parts = ip.split('.').map(Number);
    const [a = 0, b = 0] = parts;
    if (a === 0) return true; // "this network"
    if (a === 10) return true; // private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local + metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast + reserved
    return false;
  }

  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true; // unspecified + loopback
  if (lower.startsWith('fe80')) return true; // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:127.0.0.1) — judge by the embedded address.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
  if (mapped?.[1] !== undefined) return isBlockedAddress(mapped[1]);
  return false;
}

/** Cheap, synchronous checks that don't need DNS. Returns null when fine. */
export function staticUrlRejection(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'not a valid URL';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return `unsupported protocol ${url.protocol}`;
  // Credentials in a URL are never legitimate here and can leak into logs.
  if (url.username !== '' || url.password !== '') return 'URL carries credentials';

  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (host === '') return 'no hostname';
  if (BLOCKED_HOSTNAMES.has(host)) return `blocked hostname ${host}`;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return `blocked local domain ${host}`;

  // A literal IP can be judged without resolving it.
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(bare) !== 0 && isBlockedAddress(bare)) return `blocked address ${bare}`;

  return null;
}

/**
 * Full check, including DNS.
 *
 * A hostname that looks public can still resolve into a private range — the
 * classic DNS-rebinding shape — so the resolved addresses are checked too.
 * Returns null when the URL is safe to fetch, or a reason when it isn't.
 */
export async function rejectUnsafeUrl(raw: string): Promise<string | null> {
  const staticReason = staticUrlRejection(raw);
  if (staticReason !== null) return staticReason;

  const host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (net.isIP(host) !== 0) return null; // already judged above

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch {
    return `could not resolve ${host}`;
  }
  if (addresses.length === 0) return `could not resolve ${host}`;
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) return `${host} resolves to blocked address ${address}`;
  }
  return null;
}
