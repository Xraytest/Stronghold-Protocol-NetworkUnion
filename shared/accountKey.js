// shared/accountKey.js — the account key (长字符串密钥) format and display-name normalisation (DESIGN §27).
//
// Why a key and not a username/password pair (the owner's requirement, 2026-10-08): the remake has no accounts, no
// e-mail and no password recovery (docs/design/overview.md lists trophies/progression persistence as out of scope v1).
// For the public deployment the identity is instead a 160-bit random string the SERVER generates once, returns exactly
// once and the browser caches in localStorage; the player is asked to keep a copy of it. The key *is* the credential:
// whoever holds it holds the account. There is nothing to remember and nothing to guess — 160 random bits cannot be
// brute-forced, so the whole account-security story reduces to (a) the key never leaks to anyone but its owner,
// (b) only a hash of it is ever stored server-side, and (c) the endpoints that accept it are rate limited.
//
// Format: 20 random bytes in Crockford base32 — the alphabet drops I, L, O and U so a hand-copied key has no
// ambiguous characters — 32 characters, displayed in 8 groups of 4 separated by '-' (39 characters, e.g.
// `4ZQK-8M2P-...`). Parsing accepts lower case, spaces and missing dashes: a pasted key is canonicalised, never
// refused for its separators. The rarely hand-typed I/L/O/U are mapped to their Crockford digits (I, L → 1; O → 0;
// U → V), which is lossless because a canonical key never contains them.
//
// Pure ESM, no Node APIs: server/accounts.js mints the bytes with node:crypto and both sides share the parsing, so the
// client can validate, format and display a key without importing server code.

import { NAME_MAX_LEN } from './constants.js';

/** Crockford base32: no I, L, O, U. */
export const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Random bytes per key: 160 bits. */
export const KEY_BYTES = 20;
/** Characters per canonical key: 20 bytes × 8 / 5 = 32. */
export const KEY_CHARS = 32;
/** Characters per displayed group. */
export const KEY_GROUP = 4;
/** Protocol field limit for `hello.key` / `account.login.key` (the formatted form is 39 characters). */
export const KEY_MAX_LEN = 64;

const KEY_SET = new Set(KEY_ALPHABET);
/** Crockford's confusable map — the letters the alphabet leaves out and a human may type instead. */
const CONFUSABLE = Object.freeze({ I: '1', L: '1', O: '0', U: 'V' });
const SEPARATORS = new Set(['-', ' ', '\t', '_']);

/**
 * Render random bytes as a canonical (bare, upper-case) key.
 * @param {Uint8Array | number[]} bytes
 * @returns {string}
 */
export function encodeKey(bytes) {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | (b & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += KEY_ALPHABET[(acc >>> bits) & 31];
    }
  }
  if (bits > 0) out += KEY_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * The canonical 32-character key of any accepted spelling, or null when the input is not a key.
 * Accepts lower case, separators (`-`, space, tab, `_`) and the Crockford confusables.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function canonicalKey(raw) {
  if (typeof raw !== 'string') return null;
  let out = '';
  for (const ch of raw) {
    const c = ch.toUpperCase();
    if (SEPARATORS.has(c)) continue;
    const mapped = KEY_SET.has(c) ? c : CONFUSABLE[c];
    if (!mapped) return null;
    out += mapped;
    if (out.length > KEY_CHARS) return null;
  }
  return out.length === KEY_CHARS ? out : null;
}

/** Whether the input is an account key in any accepted spelling. */
export const isKey = (raw) => canonicalKey(raw) !== null;

/**
 * Display form of a key: groups of four, e.g. `4ZQK-8M2P-…`. A non-key input is returned uppercased and truncated for
 * display purposes only (never for authentication — callers must use `canonicalKey` for that).
 * @param {unknown} raw
 * @returns {string}
 */
export function formatKey(raw) {
  const c = canonicalKey(raw) || String(raw ?? '').toUpperCase();
  return c.replace(/(.{4})(?=.)/g, '$1-');
}

// ---- display names ------------------------------------------------------------------------------

/**
 * Characters that must never reach a stored name: C0/C1 controls (terminal escapes), the soft hyphen, Arabic letter
 * mark, Mongolian vowel separator, zero-width and bidi controls (invisible text and right-to-left overrides — the
 * classic way to make two different names render identically), line/paragraph separators, the BOM and the
 * interlinear annotation marks. `sanitizeName` in server/net.js strips a similar set for the wire nickname; the
 * account name is a stored, unique, friend-visible string, so it gets the same treatment plus NFKC folding.
 */
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]/g;

/**
 * Display form of an account name: NFKC-composed circles/ligatures/full-width characters folded to their canonical
 * form, invisibles removed, runs of whitespace collapsed, trimmed, at most NAME_MAX_LEN code points. Returns '' for
 * anything that has no displayable content.
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .normalize('NFKC')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .trim();
  return [...s].slice(0, NAME_MAX_LEN).join('').trim();
}

/**
 * Uniqueness key of a name: the display form case-folded, so `Fang`, `fang` and `ＦＡＮＧ` are one account name.
 * Case folding here is deliberately simple (`toLowerCase`), because NFKC already removed the compatibility forms that
 * would otherwise fold differently.
 * @param {unknown} raw
 * @returns {string}
 */
export function nameKey(raw) { return normalizeName(raw).toLowerCase(); }

/**
 * Short public discriminator of an account id, shown next to a friend's name (`Fang #7C3A`) so two accounts with a
 * similar-looking name stay distinguishable even though names are unique.
 * @param {unknown} id
 * @returns {string}
 */
export function accountTag(id) {
  const s = String(id ?? '');
  return s.length >= 4 ? s.slice(-4).toUpperCase() : s.toUpperCase();
}
