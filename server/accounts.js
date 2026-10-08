// server/accounts.js — the account layer: long-string keys, the "played together" ledger, the friend graph and quick
// invites (DESIGN §27). This is the one part of the server that survives a restart.
//
// The model, and why it is shaped this way:
//
//   * **Identity without passwords.** `create()` mints a 160-bit key (shared/accountKey.js), stores only its SHA-256
//     digest and returns the key exactly once. `login()` proves possession of the digest. There is no other credential:
//     no e-mail, no recovery, no reset link — an account whose key is lost is gone, which is what the player is warned
//     about and why the browser keeps a copy. A digest (not the key) is stored so a leaked `state/accounts.json` cannot
//     be replayed against the server; a per-deployment pepper (SP_KEY_PEPPER) additionally makes the file useless
//     against a *different* deployment. The digest lookup is a Map lookup, so an unknown key costs one SHA-256 and
//     reveals nothing (no timing side channel that distinguishes "no such account" from "wrong key" — both are
//     ACCOUNT_BAD_KEY).
//
//   * **The friend graph has exactly one door.** There is no search, no add-by-name and no add-by-id: the only accounts
//     a player can ask to be friends with are the ones this ledger recorded at the end of a match they played together
//     (`recordPlayed`, called by server/lobby.js from the match lifecycle), and only while that edge is younger than
//     MET_TTL_MS. A request still needs the other side to accept (friend.request → popup on the other end), and a
//     decline puts the pair on a cooldown so "request → refuse → request" cannot be used as a notification channel.
//
//   * **Everything is bounded.** Accounts, friends, pending requests, invites, ledger entries and the persistence file
//     itself all have hard caps, and every dynamic-keyed collection is a Map or a Set — never a plain object — so a
//     wire value of `__proto__` or `constructor` is just an unknown id and can never reach a prototype.
//
//   * **Persistence is atomic and defensive.** `state/accounts.json` is written to a temp file and renamed; a corrupt,
//     oversized or hand-edited file is moved aside and the server starts empty instead of crashing or overwriting
//     evidence. Nothing is written unless the deployment asked for a file (tests: no file).
//
// The store is deliberately transport-agnostic: it never touches a socket. server/lobby.js owns the wire side and the
// room-derived presence; this module owns every rule about who may be friends with whom.

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ERR, NAME_MAX_LEN, MAX_FRIENDS, MAX_MET, MET_TTL_MS, MAX_PENDING_REQUESTS, INVITE_TTL_MS, MAX_INVITES_OUT, MAX_INVITES_IN } from '../shared/constants.js';
import { encodeKey, canonicalKey, formatKey, normalizeName, nameKey, KEY_BYTES } from '../shared/accountKey.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** On-disk format version; a newer file than the running build is refused (never mis-read). */
export const ACCOUNT_FILE_VERSION = 1;
/** Hard cap for the persistence file: anything larger is treated as corrupt (never parsed, never overwritten). */
export const MAX_ACCOUNT_FILE_BYTES = 64 * 1024 * 1024;
/** How long a decline keeps a pair quiet (ms). */
export const DECLINE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-deployment cap on account creation from one network key, per hour (0 = unlimited). */
const CREATE_PER_ADDR_PER_HOUR = 20;
/** How long an invite for the same friend may not be repeated (ms). */
const INVITE_COOLDOWN_MS = 20_000;
/** Cap of the invite-cooldown map (bounded so a hostile client cannot grow it). */
const INVITE_COOLDOWN_MAX = 4096;
const MAX_ACCOUNTS = 5000;
const ID_BYTES = 10;   // 80 bits of public id: unguessable, but not a credential
const ID_PREFIX = 'a_';
const INVITE_PREFIX = 'i_';
const HEX64 = /^[0-9a-f]{64}$/;

/** Whether an id has the shape this module mints (used on load; never a security boundary by itself). */
const isAccountId = (v) => typeof v === 'string' && v.startsWith(ID_PREFIX) && v.length <= 40 && /^[A-Za-z0-9_]+$/.test(v);

/**
 * One account record. Collections are Maps/Sets on purpose (see the header): ids come from the wire and a plain object
 * would make `__proto__` a live prototype write on the persistence round trip.
 * @typedef {{
 *   id: string, name: string, keyHash: string, createdAt: number, lastSeenAt: number,
 *   playedWith: Map<string, number>, friends: Set<string>, incoming: Set<string>, outgoing: Set<string>,
 *   declined: Map<string, number>,
 * }} Account
 */

/** SHA-256 hex of the peppered canonical key. */
function hashKey(canonical, pepper) {
  return createHash('sha256').update(pepper ? `${pepper}\u0000${canonical}` : canonical).digest('hex');
}

export class AccountStore {
  /**
   * @param {{ file?: string | null, log?: object, now?: () => number, keyPepper?: string,
   *           maxAccounts?: number, maxFriends?: number, maxMet?: number, inviteTtlMs?: number,
   *           saveDelayMs?: number, createPerAddrPerHour?: number }} [opts]
   *   `file: null` (the default) keeps everything in memory — what tests use, so no test writes into the repo.
   */
  constructor({
    file = null, log = noopLog, now = Date.now, keyPepper = '', maxAccounts = MAX_ACCOUNTS,
    maxFriends = MAX_FRIENDS, maxMet = MAX_MET, inviteTtlMs = INVITE_TTL_MS, saveDelayMs = 1500,
    createPerAddrPerHour = CREATE_PER_ADDR_PER_HOUR,
  } = {}) {
    this.file = typeof file === 'string' && file.length > 0 ? file : null;
    this.log = log;
    this.now = now;
    this.keyPepper = typeof keyPepper === 'string' ? keyPepper : '';
    this.maxAccounts = clampInt(maxAccounts, 1, 1e6, MAX_ACCOUNTS);
    this.maxFriends = clampInt(maxFriends, 0, 1000, MAX_FRIENDS);
    this.maxMet = clampInt(maxMet, 0, 5000, MAX_MET);
    this.inviteTtlMs = clampInt(inviteTtlMs, 1000, 3600_000, INVITE_TTL_MS);
    this.saveDelayMs = clampInt(saveDelayMs, 0, 60_000, 1500);
    this.createPerAddrPerHour = clampInt(createPerAddrPerHour, 0, 1e6, CREATE_PER_ADDR_PER_HOUR);
    /** @type {Map<string, Account>} */ this.byId = new Map();
    /** @type {Map<string, Account>} */ this.byKeyHash = new Map();
    /** @type {Map<string, string>} nameKey → accountId */ this.byName = new Map();
    /** @type {Map<string, object>} inviteId → invite */ this.invites = new Map();
    /** @type {Map<string, Set<string>>} accountId → invite ids it received */ this.invitesIn = new Map();
    /** @type {Map<string, Set<string>>} accountId → invite ids it sent */ this.invitesOut = new Map();
    /** @type {Map<string, number>} network key → window start */ this.createWindows = new Map();
    /** @type {Map<string, number>} network key → accounts created in that window */ this.createPerWindow = new Map();
    /** @type {Map<string, number>} `${from}|${to}` → last invite */ this.inviteCooldown = new Map();
    this.dirty = false;
    this.saveTimer = null;
    this.saving = null;
    this.closed = false;
    this.loadWarning = null;
    /** The `pepperTag` the file was loaded with: kept on disk while it mismatches (so the warning keeps firing). */
    this.filePepperTag = null;
    if (this.file) this.load();
  }

  get size() { return this.byId.size; }

  /** Counters for /healthz (never includes key material). */
  stats() {
    let friends = 0;
    let met = 0;
    for (const a of this.byId.values()) { friends += a.friends.size; met += a.playedWith.size; }
    return {
      accounts: this.byId.size, friendEdges: Math.floor(friends / 2), metEdges: Math.floor(met / 2),
      pendingRequests: this.#pendingRequests(), invites: this.invites.size, persisted: !!this.file,
    };
  }

  #pendingRequests() {
    let n = 0;
    for (const a of this.byId.values()) n += a.incoming.size;
    return n;
  }

  // -------------------------------------------------------------------------------------------------
  // Accounts
  // -------------------------------------------------------------------------------------------------

  /** @param {string} id @returns {Account | null} */
  get(id) { return typeof id === 'string' ? this.byId.get(id) || null : null; }

  /**
   * The public shape of an account (never the key hash).
   * @param {Account | null} a
   */
  profile(a) { return a ? { accountId: a.id, name: a.name } : null; }

  /**
   * Mint an account. The key is returned exactly once — the caller (server/lobby.js) puts it on the wire once and
   * never stores it.
   * @param {{ name: unknown, addrKey?: string | null }} args
   * @returns {{ ok: true, account: Account, key: string } | { error: string, detail?: string }}
   */
  create({ name, addrKey = null }) {
    const clean = normalizeName(name);
    if (!clean) return { error: ERR.BAD_MSG, detail: 'empty name' };
    const nk = nameKey(clean);
    if (this.byName.has(nk)) return { error: ERR.NAME_TAKEN };
    if (this.byId.size >= this.maxAccounts) return { error: ERR.TOO_MANY, detail: 'account limit reached' };
    const limited = this.#createAllowed(addrKey);
    if (limited) return limited;

    const canonical = encodeKey(randomBytes(KEY_BYTES));
    const account = {
      id: this.#newId(), name: clean, keyHash: hashKey(canonical, this.keyPepper),
      createdAt: this.now(), lastSeenAt: this.now(),
      playedWith: new Map(), friends: new Set(), incoming: new Set(), outgoing: new Set(), declined: new Map(),
    };
    this.byId.set(account.id, account);
    this.byKeyHash.set(account.keyHash, account);
    this.byName.set(nk, account.id);
    this.#markDirty();
    this.log.info(`[accounts] created ${account.id} (${account.name})`);
    return { ok: true, account, key: formatKey(canonical) };
  }

  /**
   * Prove a key. Unknown and malformed keys are the same answer (ACCOUNT_BAD_KEY) — the client is told the key is
   * wrong, never whether an account exists.
   * @param {unknown} rawKey
   * @returns {{ ok: true, account: Account } | { error: string }}
   */
  login(rawKey) {
    const canonical = canonicalKey(rawKey);
    if (!canonical) return { error: ERR.ACCOUNT_BAD_KEY };
    const account = this.byKeyHash.get(hashKey(canonical, this.keyPepper));
    if (!account) return { error: ERR.ACCOUNT_BAD_KEY };
    account.lastSeenAt = this.now();
    return { ok: true, account };
  }

  /**
   * Rename an account. Names are unique case-folded (shared/accountKey.js nameKey), so `Fang` and `ＦＡＮＧ` collide.
   * @param {Account} account @param {unknown} rawName
   * @returns {{ ok: true, account: Account } | { error: string }}
   */
  rename(account, rawName) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    const clean = normalizeName(rawName);
    if (!clean) return { error: ERR.BAD_MSG, detail: 'empty name' };
    const nk = nameKey(clean);
    const holder = this.byName.get(nk);
    if (holder && holder !== account.id) return { error: ERR.NAME_TAKEN };
    if (clean === account.name) return { ok: true, account };
    // Free the name we are leaving: a stale entry would keep it reserved forever (nobody could ever take it) and the
    // map would grow with every rename. The new key is then set unconditionally (a case-only change reuses the key).
    const prevKey = nameKey(account.name);
    if (this.byName.get(prevKey) === account.id) this.byName.delete(prevKey);
    this.byName.set(nk, account.id);
    account.name = clean;
    this.#markDirty();
    return { ok: true, account };
  }

  /**
   * Mint a fresh key for an account: the old key stops working immediately (its digest is no longer indexed). The
   * caller keeps the requesting session and is handed the key once.
   * @param {Account} account @returns {{ ok: true, key: string } | { error: string }}
   */
  rotate(account) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    const canonical = encodeKey(randomBytes(KEY_BYTES));
    if (this.byKeyHash.get(account.keyHash) === account) this.byKeyHash.delete(account.keyHash);
    account.keyHash = hashKey(canonical, this.keyPepper);
    this.byKeyHash.set(account.keyHash, account);
    this.#markDirty();
    this.log.info(`[accounts] rotated key of ${account.id}`);
    return { ok: true, key: formatKey(canonical) };
  }

  /** Remember that an account was seen (drives nothing but the persisted lastSeenAt / future pruning). */
  touch(account) {
    if (!account) return;
    account.lastSeenAt = this.now();
  }

  #newId() {
    for (let i = 0; i < 100; i++) {
      const id = ID_PREFIX + randomBytes(ID_BYTES).toString('hex');
      if (!this.byId.has(id)) return id;
    }
    // 80 random bits colliding 100 times in a row is not a thing; fall back to a longer id rather than throw.
    return ID_PREFIX + randomBytes(ID_BYTES + 8).toString('hex');
  }

  /** @returns {{ error: string, detail?: string } | null} */
  #createAllowed(addrKey) {
    if (this.createPerAddrPerHour <= 0 || typeof addrKey !== 'string' || !addrKey) return null;
    const now = this.now();
    let win = this.createWindows.get(addrKey);
    // A missing, stale or future window starts a new one (the `now < win` case is a backwards clock jump).
    if (!win || now - win >= 3600_000 || now < win) {
      this.#pruneCreateWindows(now);
      this.createWindows.set(addrKey, now);
      this.createPerWindow.set(addrKey, 0);
    }
    const used = this.createPerWindow.get(addrKey) || 0;
    if (used >= this.createPerAddrPerHour) return { error: ERR.RATE, detail: 'too many accounts from your network' };
    this.createPerWindow.set(addrKey, used + 1);
    return null;
  }

  #pruneCreateWindows(now) {
    if (this.createWindows.size < 4096) return;
    for (const [k, at] of this.createWindows) if (now - at >= 3600_000) { this.createWindows.delete(k); this.createPerWindow.delete(k); }
    // still full: drop the oldest half (a bounded, deterministic fallback)
    if (this.createWindows.size >= 4096) {
      const keys = [...this.createWindows.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2048).map(([k]) => k);
      for (const k of keys) { this.createWindows.delete(k); this.createPerWindow.delete(k); }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // The "played together" ledger — the only door to a friend request
  // -------------------------------------------------------------------------------------------------

  /**
   * Record that these accounts finished a match together (server/lobby.js calls it when a match starts, which is when
   * the room's players demonstrably entered the same battle). Pairwise, newest-wins per pair.
   * Bots and spectators are not passed in: only accounts of human players count.
   * @param {Array<string | null | undefined>} accountIds
   * @returns {number} edges written
   */
  recordPlayed(accountIds) {
    const ids = [...new Set((accountIds || []).filter((x) => typeof x === 'string' && this.byId.has(x)))];
    if (ids.length < 2) return 0;
    const at = this.now();
    let n = 0;
    for (const a of ids) {
      const acc = this.byId.get(a);
      for (const b of ids) {
        if (a === b) continue;
        acc.playedWith.set(b, at);
        n++;
      }
      this.#pruneMet(acc);
    }
    this.#markDirty();
    return n;
  }

  /** Keep only the newest `maxMet` partners (a ledger entry is cheap but unbounded growth is not). */
  #pruneMet(account) {
    if (account.playedWith.size <= this.maxMet) return;
    const sorted = [...account.playedWith.entries()].sort((a, b) => b[1] - a[1]);
    account.playedWith = new Map(sorted.slice(0, this.maxMet));
  }

  /** Whether `targetId` is a partner this account played with, inside the eligibility window. */
  isEligible(account, targetId) {
    if (!account || typeof targetId !== 'string') return false;
    const at = account.playedWith.get(targetId);
    if (typeof at !== 'number') return false;
    return this.now() - at <= MET_TTL_MS;
  }

  /**
   * The accounts this one may ask to be friends with: played-together partners that are not already friends and not
   * the subject of a pending request. Newest first.
   * @param {Account} account
   * @returns {Array<{ accountId: string, name: string, at: number }>}
   */
  metList(account) {
    if (!account) return [];
    const out = [];
    for (const [id, at] of account.playedWith) {
      if (this.now() - at > MET_TTL_MS) continue;
      if (account.friends.has(id) || account.incoming.has(id) || account.outgoing.has(id)) continue;
      const other = this.byId.get(id);
      if (!other) continue;
      out.push({ accountId: id, name: other.name, at });
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  // -------------------------------------------------------------------------------------------------
  // Friends
  // -------------------------------------------------------------------------------------------------

  areFriends(a, b) {
    return !!(a && b && typeof b === 'string' && a.friends.has(b));
  }

  isFriendOf(a, b) { return this.areFriends(a, b) && this.areFriends(b, a); }

  /** @param {Account} account @returns {string[]} */
  friendIds(account) { return account ? [...account.friends] : []; }

  /**
   * Ask `targetId` to be friends. Only a played-together partner may be asked (NOT_ELIGIBLE otherwise), and an
   * incoming request from that very account is treated as acceptance (a mutual request needs no second round trip).
   * @param {Account} account @param {string} targetId
   * @returns {{ ok: true, accepted: boolean } | { error: string, detail?: string }}
   */
  requestFriend(account, targetId) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    if (typeof targetId !== 'string' || targetId === account.id) return { error: ERR.BAD_TARGET, detail: 'not another account' };
    const target = this.byId.get(targetId);
    if (!target) return { error: ERR.BAD_TARGET };
    if (account.friends.has(targetId)) return { error: ERR.ALREADY, detail: 'already friends' };
    // housekeeping: a cooldown entry older than DECLINE_COOLDOWN_MS means nothing, so the map cannot grow forever
    if (this.#pruneDeclined(target)) this.#markDirty();
    if (target.declined.has(account.id) && this.now() - target.declined.get(account.id) < DECLINE_COOLDOWN_MS) {
      return { error: ERR.DECLINED };
    }
    if (account.incoming.has(targetId)) {
      // The mirror of a pending request: the two asked for each other, so this one accepts. The answer keeps the
      // request shape (`accepted`) — the lobby tells the two apart by it and would otherwise send a stale request push.
      const res = this.acceptFriend(account, targetId);
      return res.ok ? { ok: true, accepted: true } : res;
    }
    if (!this.isEligible(account, targetId)) return { error: ERR.NOT_ELIGIBLE };
    if (account.outgoing.has(targetId)) return { error: ERR.ALREADY, detail: 'already requested' };
    if (account.friends.size >= this.maxFriends) return { error: ERR.TOO_MANY, detail: 'your friend list is full' };
    if (target.friends.size >= this.maxFriends) return { error: ERR.TOO_MANY, detail: 'their friend list is full' };
    if (account.outgoing.size >= MAX_PENDING_REQUESTS || target.incoming.size >= MAX_PENDING_REQUESTS) {
      return { error: ERR.TOO_MANY, detail: 'too many pending requests' };
    }
    account.outgoing.add(targetId);
    target.incoming.add(account.id);
    this.#markDirty();
    return { ok: true, accepted: false };
  }

  /**
   * Accept the request `targetId` sent this account.
   * @param {Account} account @param {string} targetId
   * @returns {{ ok: true, added: boolean } | { error: string, detail?: string }}
   */
  acceptFriend(account, targetId) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    const target = this.byId.get(targetId);
    if (!target) return { error: ERR.BAD_TARGET };
    if (account.friends.has(targetId)) {
      // idempotent: clean up any half-state and answer ok
      account.outgoing.delete(targetId);
      target.incoming.delete(account.id);
      this.#markDirty();
      return { ok: true, added: false };
    }
    if (!account.incoming.has(targetId)) {
      // No request from that account to accept. A pending OUTGOING request is NOT consent: linking on it let a
      // requester accept its own request and force the friendship (adversarial review F1), and the only consent-free
      // case — both sides asked — is handled in requestFriend, which can see both directions.
      return { error: ERR.BAD_TARGET, detail: 'no pending request from that account' };
    }
    account.incoming.delete(targetId);
    return this.#link(account, target);
  }

  #link(account, target) {
    if (account.friends.size >= this.maxFriends) return { error: ERR.TOO_MANY, detail: 'your friend list is full' };
    if (target.friends.size >= this.maxFriends) return { error: ERR.TOO_MANY, detail: 'their friend list is full' };
    account.incoming.delete(target.id);
    target.outgoing.delete(account.id);
    account.outgoing.delete(target.id);
    target.incoming.delete(account.id);
    account.declined.delete(target.id);
    target.declined.delete(account.id);
    account.friends.add(target.id);
    target.friends.add(account.id);
    this.#markDirty();
    this.log.info(`[accounts] ${account.id} <-> ${target.id} friends`);
    return { ok: true, added: true };
  }

  /**
   * Refuse the request `targetId` sent (or withdraw our own). Sets the decliner's cooldown so the pair cannot be used
   * as a one-way notification channel.
   * @param {Account} account @param {string} targetId
   * @returns {{ ok: true, removed: boolean } | { error: string }}
   */
  declineFriend(account, targetId) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    const target = this.byId.get(targetId);
    if (!target) return { error: ERR.BAD_TARGET };
    let removed = false;
    let turnedDown = false;
    if (account.incoming.delete(targetId)) { target.outgoing.delete(account.id); removed = true; turnedDown = true; }
    if (account.outgoing.delete(targetId)) { target.incoming.delete(account.id); removed = true; }
    // The cooldown protects whoever was ASKED, so it is set only when the caller turned down a request addressed to
    // them. Withdrawing one's own request (the panel's 取消) must not block the other side from asking later.
    if (turnedDown) { this.#pruneDeclined(account); account.declined.set(targetId, this.now()); }
    this.#markDirty();
    return { ok: true, removed };
  }

  /**
   * Remove a friend (either side may; the edge disappears on both).
   * @param {Account} account @param {string} targetId
   * @returns {{ ok: true, removed: boolean } | { error: string }}
   */
  removeFriend(account, targetId) {
    if (!account || !this.byId.has(account.id)) return { error: ERR.INTERNAL };
    const target = this.byId.get(targetId);
    const removed = account.friends.delete(targetId);
    if (target) target.friends.delete(account.id);
    // also drop any pending state between the two
    account.incoming.delete(targetId); account.outgoing.delete(targetId);
    if (target) { target.incoming.delete(account.id); target.outgoing.delete(account.id); }
    // pending state may have been dropped even when the edge was already gone, so always persist the cleanup
    this.#markDirty();
    return { ok: true, removed };
  }

  // -------------------------------------------------------------------------------------------------
  // Quick invites
  // -------------------------------------------------------------------------------------------------

  /**
   * Mint an invite from `from` to a friend. The id is random and bound to the recipient: it is useless to anyone else
   * and cannot be guessed. Re-inviting the same friend for the same room refreshes the existing invite instead of
   * stacking a second one.
   * @param {Account} from @param {string} toId
   * @param {{ code: string, mode: string, difficulty: string, players?: number }} room
   * @returns {{ ok: true, invite: object } | { error: string, detail?: string }}
   */
  createInvite(from, toId, room) {
    if (!from || !this.byId.has(from.id)) return { error: ERR.INTERNAL };
    const to = this.byId.get(toId);
    if (!to) return { error: ERR.BAD_TARGET };
    if (from.id === toId) return { error: ERR.BAD_TARGET, detail: 'not yourself' };
    if (!this.areFriends(from, toId) || !this.areFriends(to, from.id)) return { error: ERR.NOT_FRIEND };
    this.#pruneInvites();
    const pair = `${from.id}|${toId}`;
    const last = this.inviteCooldown.get(pair);
    if (typeof last === 'number' && this.now() - last < INVITE_COOLDOWN_MS) return { error: ERR.RATE, detail: 'just invited' };
    const code = typeof room?.code === 'string' ? room.code : '';
    if (!code) return { error: ERR.BAD_MSG, detail: 'no room code' };
    // refresh an existing pending invite for the same room
    for (const id of this.invitesIn.get(toId) || []) {
      const inv = this.invites.get(id);
      if (inv && inv.from === from.id && inv.code === code) {
        inv.at = this.now();
        inv.expiresAt = this.now() + this.inviteTtlMs;
        // the room may have changed since the first invite: the recipient must see the CURRENT mode/difficulty/occupancy
        inv.fromName = from.name;
        inv.mode = room?.mode === 'solo' ? 'solo' : 'coop';
        if (typeof room?.difficulty === 'string') inv.difficulty = room.difficulty;
        inv.players = typeof room.players === 'number' ? room.players : inv.players;
        this.#rememberCooldown(pair, this.now());
        this.#markDirty();
        return { ok: true, invite: this.#wire(inv) };
      }
    }
    if ((this.invitesOut.get(from.id)?.size || 0) >= MAX_INVITES_OUT) return { error: ERR.TOO_MANY, detail: 'too many open invites' };
    const invite = {
      id: INVITE_PREFIX + randomBytes(12).toString('hex'),
      from: from.id, fromName: from.name, to: toId, code,
      mode: room?.mode === 'solo' ? 'solo' : 'coop',
      difficulty: typeof room?.difficulty === 'string' ? room.difficulty : 'NORMAL',
      players: typeof room?.players === 'number' ? room.players : 1,
      at: this.now(), expiresAt: this.now() + this.inviteTtlMs,
    };
    this.invites.set(invite.id, invite);
    this.#setIndex(this.invitesIn, toId, invite.id, true);
    this.#setIndex(this.invitesOut, from.id, invite.id, true);
    this.#rememberCooldown(pair, this.now());
    // show at most MAX_INVITES_IN at once: the oldest ones are dropped
    const inIds = [...(this.invitesIn.get(toId) || [])];
    if (inIds.length > MAX_INVITES_IN) {
      const old = inIds.map((id) => this.invites.get(id)).filter(Boolean).sort((a, b) => a.at - b.at).slice(0, inIds.length - MAX_INVITES_IN);
      for (const inv of old) this.#dropInvite(inv);
    }
    this.#markDirty();
    // `#wire`, not the internal record: the wire shape carries `inviteId` (the client's handle on the invite) and
    // never the `to` field. Returning the raw record here once made every invite un-acceptable (DESIGN §27).
    return { ok: true, invite: this.#wire(invite) };
  }

  #rememberCooldown(pair, at) {
    if (this.inviteCooldown.size >= INVITE_COOLDOWN_MAX) {
      const oldest = [...this.inviteCooldown.entries()].sort((a, b) => a[1] - b[1]).slice(0, INVITE_COOLDOWN_MAX / 2).map(([k]) => k);
      for (const k of oldest) this.inviteCooldown.delete(k);
    }
    this.inviteCooldown.set(pair, at);
  }

  /** Pending, unexpired invites addressed to an account, newest first. */
  invitesFor(accountId) {
    const out = [];
    for (const id of this.invitesIn.get(accountId) || []) {
      const inv = this.invites.get(id);
      if (!inv) continue;
      if (this.now() > inv.expiresAt) { this.#dropInvite(inv); continue; }
      out.push(this.#wire(inv));
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  /**
   * Consume an invite by id. Only the addressed account may take it; an unknown, expired or foreign invite is the same
   * answer (INVITE_GONE) so ids cannot be probed for existence.
   * @param {string} accountId @param {string} inviteId
   * @returns {{ ok: true, invite: object } | { error: string, detail?: string }}
   */
  takeInvite(accountId, inviteId) {
    const inv = typeof inviteId === 'string' ? this.invites.get(inviteId) : null;
    if (!inv || inv.to !== accountId || this.now() > inv.expiresAt) {
      if (inv && this.now() > inv.expiresAt) this.#dropInvite(inv);
      return { error: ERR.INVITE_GONE };
    }
    this.#dropInvite(inv);
    this.#markDirty();
    return { ok: true, invite: this.#wire(inv) };
  }

  /** Refuse an invite (also tells the sender, via the caller). */
  declineInvite(accountId, inviteId) {
    const inv = typeof inviteId === 'string' ? this.invites.get(inviteId) : null;
    if (!inv || inv.to !== accountId) return { error: ERR.INVITE_GONE };
    this.#dropInvite(inv);
    this.#markDirty();
    return { ok: true, invite: this.#wire(inv) };
  }

  /** Every pending invite that points at a room code (a disposed room invalidates them). */
  invitesForRoom(code) {
    const out = [];
    for (const inv of this.invites.values()) if (inv.code === code) out.push(this.#wire(inv));
    return out;
  }

  /**
   * Drop every invite pointing at a room that no longer exists. Returns what was dropped so the caller can tell the
   * senders (`invite.done`), because an invite to a dead room would only fail at accept time otherwise.
   * @param {string} code @returns {object[]}
   */
  dropInvitesForRoom(code) {
    const dropped = [];
    for (const inv of [...this.invites.values()]) {
      if (inv.code !== code) continue;
      dropped.push(this.#wire(inv));
      this.#dropInvite(inv);
    }
    if (dropped.length) this.#markDirty();
    return dropped;
  }

  #dropInvite(inv) {
    this.invites.delete(inv.id);
    this.#setIndex(this.invitesIn, inv.to, inv.id, false);
    this.#setIndex(this.invitesOut, inv.from, inv.id, false);
  }

  #setIndex(map, key, value, add) {
    let set = map.get(key);
    if (add) {
      if (!set) { set = new Set(); map.set(key, set); }
      set.add(value);
    } else if (set) {
      set.delete(value);
      if (set.size === 0) map.delete(key);
    }
  }

  /** The wire shape of an invite (what the recipient's client renders). */
  #wire(inv) {
    return {
      inviteId: inv.id, from: inv.from, fromName: inv.fromName, code: inv.code,
      mode: inv.mode, difficulty: inv.difficulty, players: inv.players, at: inv.at, expiresAt: inv.expiresAt,
    };
  }

  #pruneInvites() {
    const now = this.now();
    for (const inv of [...this.invites.values()]) if (now > inv.expiresAt) this.#dropInvite(inv);
  }

  // -------------------------------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------------------------------

  /** Read `file` if it exists. Any problem leaves the store empty (and loud in the log) — never a crash. */
  load() {
    if (!this.file) return;
    let raw;
    try {
      const st = fs.statSync(this.file);
      if (st.size > MAX_ACCOUNT_FILE_BYTES) { this.#quarantine('oversized'); return; }
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return; // first boot
      this.log.error('[accounts] cannot read the account file', e);
      this.loadWarning = 'read-failed';
      return;
    }
    let data;
    try { data = JSON.parse(raw); } catch { this.#quarantine('unparseable'); return; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { this.#quarantine('not an object'); return; }
    if (data.v !== ACCOUNT_FILE_VERSION) { this.#quarantine(`version ${String(data.v).slice(0, 16)}`); return; }
    if (data.pepperTag && data.pepperTag !== this.#pepperTag()) {
      // The keys in the file were hashed with a different pepper: nothing can log in any more. Say so loudly (the
      // operator either changed SP_KEY_PEPPER or moved the file to another deployment) but keep the accounts. The
      // file's own tag is remembered and written back untouched (see serialize) so this warning keeps firing on every
      // boot until the operator restores the pepper or deletes the file to start fresh.
      this.log.warn('[accounts] SP_KEY_PEPPER changed: every existing account key is now invalid (restore the old pepper, or delete the file to start fresh)');
      this.loadWarning = 'pepper-changed';
    }
    this.filePepperTag = typeof data.pepperTag === 'string' ? data.pepperTag : null;
    const accounts = data.accounts && typeof data.accounts === 'object' ? data.accounts : {};
    let skipped = 0;
    for (const [id, rec] of Object.entries(accounts)) {
      if (this.byId.size >= this.maxAccounts) { skipped++; continue; }
      const account = this.#revive(id, rec);
      if (!account) { skipped++; continue; }
      this.byId.set(account.id, account);
      this.byKeyHash.set(account.keyHash, account);
      this.byName.set(nameKey(account.name), account.id);
    }
    // A friend/ledger edge only counts when both ends exist AND mirror each other (a half-edge or a forged one-way
    // edge from a hand-edited file is dropped: the ledger is the only door, so nothing else may create a friendship).
    for (const a of this.byId.values()) {
      a.friends = new Set([...a.friends].filter((id) => this.byId.get(id)?.friends.has(a.id)));
      a.incoming = new Set([...a.incoming].filter((id) => this.byId.get(id)?.outgoing.has(a.id)));
      a.outgoing = new Set([...a.outgoing].filter((id) => this.byId.get(id)?.incoming.has(a.id)));
      a.playedWith = new Map([...a.playedWith].filter(([id]) => this.byId.has(id)));
      a.declined = new Map([...a.declined].filter(([id]) => this.byId.has(id)));
      // The file may claim more than the caps allow (a hand-edited or older file): clamp to the real limits.
      if (a.friends.size > this.maxFriends) a.friends = new Set([...a.friends].slice(0, this.maxFriends));
      if (a.incoming.size > MAX_PENDING_REQUESTS) a.incoming = new Set([...a.incoming].slice(0, MAX_PENDING_REQUESTS));
      if (a.outgoing.size > MAX_PENDING_REQUESTS) a.outgoing = new Set([...a.outgoing].slice(0, MAX_PENDING_REQUESTS));
      this.#pruneMet(a);
      a.declined = this.#liveDeclined(a);
    }
    this.log.info(`[accounts] loaded ${this.byId.size} account(s) from ${this.file}${skipped ? ` (${skipped} skipped)` : ''}`);
  }

  /** @returns {Account | null} */
  #revive(id, rec) {
    if (!isAccountId(id) || !rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
    const name = normalizeName(rec.name);
    const keyHash = typeof rec.keyHash === 'string' && HEX64.test(rec.keyHash) ? rec.keyHash : null;
    // COUNT CODE POINTS, not UTF-16 units: normalizeName caps at NAME_MAX_LEN code points, so a name of emoji (each 2
    // units) would otherwise be created, written, and then silently dropped on the next boot — locking the player out.
    if (!name || !keyHash || [...name].length > NAME_MAX_LEN) return null;
    const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);
    const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
    const stamps = (v, cap) => new Map((Array.isArray(v) ? v : []).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number').slice(0, cap));
    return {
      id, name, keyHash, createdAt: num(rec.createdAt, this.now()), lastSeenAt: num(rec.lastSeenAt, this.now()),
      playedWith: stamps(rec.playedWith, this.maxMet),
      friends: new Set(ids(rec.friends).slice(0, this.maxFriends)),
      incoming: new Set(ids(rec.incoming).slice(0, MAX_PENDING_REQUESTS)),
      outgoing: new Set(ids(rec.outgoing).slice(0, MAX_PENDING_REQUESTS)),
      declined: stamps(rec.declined, MAX_PENDING_REQUESTS),
    };
  }

  /** Drop decline-cooldown entries that have expired (they are only ever read inside DECLINE_COOLDOWN_MS). */
  #pruneDeclined(account) {
    if (account.declined.size === 0) return false;
    const live = this.#liveDeclined(account);
    if (live.size === account.declined.size) return false; // nothing expired and within the cap
    account.declined = live;
    return true;
  }

  /** The projectable form of `declined`: live entries only, newest first, capped (used by load and serialize). */
  #liveDeclined(account) {
    const now = this.now();
    return new Map([...account.declined.entries()]
      .filter(([, at]) => now - at <= DECLINE_COOLDOWN_MS)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_PENDING_REQUESTS));
  }

  /** Move a bad file aside (never overwrite it) and start empty. */
  #quarantine(why) {
    this.loadWarning = why;
    this.log.error(`[accounts] ${this.file} is ${why}: starting with no accounts (the file is kept aside)`);
    try {
      // a unique aside name: two quarantines in the same millisecond must not clobber each other, and the original
      // file must survive even if this rename fails
      const aside = `${this.file}.corrupt-${Date.now()}-${randomBytes(3).toString('hex')}`;
      fs.renameSync(this.file, aside);
    } catch { /* best effort */ }
  }

  #pepperTag() {
    return createHash('sha256').update(`pepper:${this.keyPepper}`).digest('hex').slice(0, 16);
  }

  /** The serialisable form (Maps/Sets → arrays). */
  serialize() {
    const accounts = {};
    for (const a of this.byId.values()) {
      accounts[a.id] = {
        name: a.name, keyHash: a.keyHash, createdAt: a.createdAt, lastSeenAt: a.lastSeenAt,
        // newest-first cap: a Map keeps insertion order, which is not time order after a reload
        playedWith: [...a.playedWith.entries()].sort((x, y) => y[1] - x[1]).slice(0, this.maxMet),
        friends: [...a.friends], incoming: [...a.incoming], outgoing: [...a.outgoing],
        declined: [...this.#liveDeclined(a)],
      };
    }
    return { v: ACCOUNT_FILE_VERSION, savedAt: this.now(), pepperTag: this.filePepperTag || this.#pepperTag(), accounts };
  }

  #markDirty() {
    if (!this.file || this.closed) return;
    this.dirty = true;
    if (this.saveTimer || this.saving) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.save().catch((e) => this.log.error('[accounts] save failed', e)); }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  /** Write the file now (atomic: temp + rename). Serialised behind `saving` so a burst of changes writes once. */
  async save() {
    if (!this.file || this.closed) return;
    if (this.saving) { this.dirty = true; return; }
    if (!this.dirty) return;
    this.dirty = false;
    this.saving = (async () => {
      const json = JSON.stringify(this.serialize());
      const bytes = Buffer.byteLength(json);
      if (bytes > MAX_ACCOUNT_FILE_BYTES) {
        this.log.error(`[accounts] refusing to write ${bytes} bytes (cap ${MAX_ACCOUNT_FILE_BYTES})`);
        return;
      }
      const dir = path.dirname(this.file);
      await fsp.mkdir(dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      await fsp.writeFile(tmp, json, { mode: 0o600 });
      await fsp.rename(tmp, this.file);
    })();
    try { await this.saving; } finally {
      this.saving = null;
      if (this.dirty) this.#markDirty();
    }
  }

  /** Await every pending write (tests + shutdown). */
  async flush() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.saving) await this.saving.catch(() => {});
    if (this.dirty) await this.save().catch(() => {});
  }

  /** Stop the save timer and write once more. */
  async close() {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }
}

/** Coerce an option into a sane integer. */
function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}
