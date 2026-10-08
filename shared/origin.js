// shared/origin.js — canonical origins for share links (DESIGN §27.1).
//
// The problem: a public deployment usually sits behind an frp-like reverse tunnel (cloudflared, frp, Tailscale
// Funnel, nginx), so the server cannot know which address the player actually reached it by — LAN IP, a tunnel
// hostname, a domain. The browser does know (`location.origin`), and the official client behaves the same way: the
// invite link is the page's own URL plus `?room=CODE`. The client therefore reports its origin, and the server turns it
// into the canonical link other players are handed.
//
// The risk this module exists to contain: a client-supplied origin is attacker-controlled input. Whatever the server
// echoes back can end up in someone else's clipboard, so an unchecked value would let a room member mint a phishing
// link (`https://evil.example/?room=CODE`) that looks like the game's own share link. The rule is therefore:
//
//   * the canonical form is computed with the WHATWG URL parser and compared strictly — a value with a path, a query,
//     a fragment, credentials, a non-http(s) scheme or a non-canonical spelling is rejected outright (so a link can
//     never smuggle `?room=`, `#`, or a second URL inside itself);
//   * an origin is accepted only when it equals the origin this very connection arrived on (the `Host` header, or the
//     forwarded host when the deployment trusts its reverse proxy) — that is the address the player demonstrably used;
//   * a deployment that knows its public address can pin it with an allowlist (`SP_PUBLIC_ORIGINS`), which then becomes
//     EXCLUSIVE: an unlisted origin is refused even if the connection came in on it (this is what stops a player from
//     pointing their own tunnel at the server and handing out links through it);
//   * and the server never broadcasts an origin to other players — every session gets its own answer, and the client
//     falls back to its own `location.origin` when the server has no opinion. A wrong answer can therefore never make
//     the game hand out a link to somebody else's address.
//
// Pure ESM (URL is a standard global): server and browser share the same parsing.

/** Protocol field limit for `hello.origin` (a Host header is at most 255 characters). */
export const ORIGIN_MAX_LEN = 128;
/** Limit for one entry of the allowlist. */
const HOST_MAX_LEN = 255;
const SCHEMES = new Set(['http:', 'https:']);

/**
 * Canonical origin of a URL string, or null when it is not a bare http(s) origin.
 * Rejects credentials, paths, queries, fragments, non-http(s) schemes and overly long input.
 * @param {unknown} raw
 * @returns {string | null} e.g. `https://game.example:8443`
 */
export function canonicalOrigin(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > ORIGIN_MAX_LEN) return null;
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (!SCHEMES.has(url.protocol)) return null;
  if (url.username || url.password) return null;
  if (url.pathname !== '/' || url.search || url.hash) return null;
  if (!url.hostname || url.hostname.length > HOST_MAX_LEN) return null;
  const origin = url.origin;
  return origin && origin !== 'null' ? origin : null;
}

/**
 * Canonical origin for a `Host` header (optionally with the scheme a trusted proxy reported).
 * @param {unknown} host e.g. `game.example:8443`, `[::1]:3000`
 * @param {unknown} proto `http` | `https` (anything else counts as http)
 * @returns {string | null}
 */
export function originFromHost(host, proto) {
  if (typeof host !== 'string' || host.length === 0 || host.length > HOST_MAX_LEN) return null;
  // A Host header is a host[:port]; refuse anything with the characters that would let it escape into the URL parser.
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(host)) return null;
  const scheme = proto === 'https' ? 'https' : 'http';
  return canonicalOrigin(`${scheme}://${host}`);
}

/**
 * Parse a `SP_PUBLIC_ORIGINS` value (comma/space separated) into a canonical, de-duplicated list.
 * Invalid entries are dropped (the caller logs them).
 * @param {unknown} value
 * @returns {{ origins: string[], invalid: string[] }}
 */
export function parseOriginList(value) {
  const origins = [];
  const invalid = [];
  for (const part of String(value ?? '').split(/[,\s]+/)) {
    if (!part) continue;
    const origin = canonicalOrigin(part);
    if (!origin) invalid.push(part);
    else if (!origins.includes(origin)) origins.push(origin);
  }
  return { origins, invalid };
}

/**
 * Whether a reported origin may be used for share links.
 *
 * `allow` (the configured allowlist) is EXCLUSIVE when non-empty. Otherwise the reported origin has to be the origin
 * of the connection it arrived on — the address the browser demonstrably used to reach this server.
 *
 * @param {unknown} reported the `hello.origin` value (already canonicalised, or null)
 * @param {{ allow?: string[] | null, connOrigin?: string | null }} ctx
 * @returns {boolean}
 */
export function isAllowedOrigin(reported, { allow = null, connOrigin = null } = {}) {
  if (typeof reported !== 'string' || reported.length === 0) return false;
  if (Array.isArray(allow) && allow.length > 0) return allow.includes(reported);
  return typeof connOrigin === 'string' && connOrigin.length > 0 && reported === connOrigin;
}

/**
 * The origin a session may hand out: the reported one when it is allowed, else the connection's own canonical origin
 * when that is allowed (a client that reported nothing, or reported something stale, still gets a usable link), else
 * null — the client then falls back to its own `location.origin`.
 * @param {{ reported?: unknown, connOrigin?: string | null, allow?: string[] | null }} ctx
 * @returns {string | null}
 */
export function pickShareOrigin({ reported = null, connOrigin = null, allow = null } = {}) {
  if (isAllowedOrigin(reported, { allow, connOrigin })) return String(reported);
  if (isAllowedOrigin(connOrigin, { allow, connOrigin })) return String(connOrigin);
  return null;
}
