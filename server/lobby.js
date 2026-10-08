// server/lobby.js — rooms, seats, host, AI seats, ready/start, reconnect, and room → Match wiring
// (DESIGN §2, §6.1 LOBBY, §8.1). Implements the handler interface consumed by server/net.js.
//
// Rules (the choices where DESIGN is silent are marked ▸):
//   * Rooms are keyed by 4-letter codes from an unambiguous alphabet (no I/O, letters only). Join codes are
//     case-insensitive.
//   * 'solo' rooms hold exactly one human and never bots. 'coop' rooms have 4 seats (humans + AI bots).
//     Humans and bots take the lowest free seat index; seat indexes never compact.
//   * ▸ Being in a LOBBY room and sending room.create / room.join implicitly leaves it. While your room is
//     in a match, create/join of another room fails with ROOM_STARTED (send g.leave or room.leave first).
//   * Host-only: room.setDifficulty, room.addBot, room.removeBot, room.kick, room.start. ▸ Changing the difficulty
//     un-readies the other humans. ▸ room.start requires every other human to be connected and ready;
//     the host's start counts as the host's ready (the host may still toggle room.ready for display).
//   * room.kick {seat, playerId} (community report #17, owner approved): before the match only, the host removes another
//     human like an AI seat (an AI seat stays room.removeBot's; never the host itself). `playerId` names the player the
//     host confirmed: a seat that changed hands meanwhile (left, someone else joined) is refused with BAD_TARGET. The
//     seat is freed at once and the player gets `room.closed {reason:'kicked'}` — now, or on the next resume when
//     offline (with the result replay, as the grace timeout) —, so the reconnect token no longer leads back to the seat
//     (it stays the player's identity: net.js sessions belong to players, not seats). ▸ No ban: the player may join
//     again with the code.
//   * Host migration: when the host leaves (or is removed), the lowest-seat remaining human (connected
//     ones first) becomes host. A room without humans is disposed (bots never keep a room alive).
//   * Disconnect in LOBBY: the seat shows connected=false and is freed after `lobbyGraceMs` (60 s); a
//     session that comes back after that gets `room.closed {reason:'timeout'}`.
//     Disconnect in a match: the seat is kept and match.onDisconnect(playerId) is called.
//   * Reconnect: `hello` with a known token (reconnect window, 10 min, see net.js) rebinds the session;
//     the lobby then broadcasts room.state and, in a match, calls match.onReconnect(playerId).
//     Solo runs (下半: "休整期及机变阶段没有时间限制…24小时内随时返回", research 01 §1 / 06 §17): a session that drops
//     while its solo room's match runs stays resumable for the official `config.constants.singleReconnectTime`
//     (86400 s; option `soloReconnectWindowMs` overrides it) instead of the 10-minute window — the untimed solo match
//     simply waits (net.js session.resumeWindowMs, set at every disconnect). Only after that does expiry turn into
//     match.onLeave ('abandoned'). The extension outlives the match, so a run that ended meanwhile (e.g. a server-run
//     Final Assault) still shows its result on the player's return.
//     A repeated hello on a live connection is a full resync: room.state goes to the requester only
//     (broadcast only when the seat visibly changed, e.g. a rename in LOBBY); the heavy part (match.onReconnect,
//     or the result replay below) runs at most once per `resyncMinGapMs` per session — extra requests inside
//     that window coalesce into one deferred resync, so hello spam cannot amplify into ~15 KB per request.
//   * Result replay: the match's final m.public and each human's m.result are kept after the match ends. A
//     human who resyncs (resume after a drop, a reloaded tab, a repeated hello) while the room is back in LOBBY
//     gets room.state followed by those two frames again, until they act in the room (ready, difficulty, AI
//     seats, start), leave it, or a new match starts. A human removed by the lobby grace gets them right after
//     `room.closed {timeout}` on their next resume (Match.onReconnect cannot do this: the lobby drops the
//     match reference at onEnd and disposes it on the next macrotask).
//   * Per-network limits (internet clients only, see net.js clientAddress): at most `maxRoomsPerAddr` rooms
//     created from one network may exist at once and at most `maxMatchesPerAddr` matches started from one
//     network may run at once (room.create / room.start → ERR.RATE). Without them a socket loop could fill
//     `maxRooms` or keep hundreds of unattended matches simulating for the whole reconnect window.
//   * Permanent departure during a match (room.leave, g.leave, reconnect window expired): the seat is
//     marked departed (shown as connected=false), match.onLeave(playerId) is called, and the seat is freed
//     when the match ends. 'g.leave' is handled here and never reaches match.handle().
//   * All other 'g.*' messages go to room.match.handle(playerId, msg); its {ok}/{error} becomes the reply.
//   * Match lifecycle: room.start → new Match({...}) → room.state (inMatch=true) → match.start(). The match gets
//     `matchNo` = the room's match number (1, 2, …): with the seed it keeps battleIds unique across the room's
//     matches, so a late b.progress / b.result of the previous match is ignored by the next one (DESIGN §14).
//     onEnd(summary) → room back to LOBBY (departed seats freed, humans un-readied, disconnected humans
//     get the lobby grace), dispose() on the next macrotask. Players can start again.
//   * room.closed reasons: 'timeout' (removed after lobby grace), 'kicked' (room.kick, room.removeSpectator), 'empty' (a
//     spectator whose room lost its last player), 'shutdown' (server stopping).
//   * Operator loadout (DESIGN §16): room.loadout { entries } is checked strictly against the game data
//     (shared/protocol.js checkLoadout: known visible chess, a skill index legal for the normal AND the elite status, a
//     module of the elite or 'none'; any bad entry rejects the whole message, nothing is stored). ▸ It is stored on the
//     session (it follows the player into every room they create/join, and survives a resume) and on the seat; the
//     match receives seats[].loadout (bots: none — they fight with the defaults). ▸ Accepted any time: in a LOBBY room
//     (or outside a room) it simply replaces the stored one; while the room's match runs it is also handed to
//     match.setLoadout(playerId, loadout), which accepts it only during INFO_CHECK (the 干员调配 entry of the briefing)
//     and refuses it afterwards (WRONG_PHASE: the match's loadout is locked, the stored one applies to the next match).
//   * Operator ownership (干员持有, 0.2.0 补位, owner's decision 2026-10-05): room.ownership { notOwned } — the base chess
//     ids the player marked as not owned — is checked leniently (shared/protocol.js checkNotOwned: anything that is not
//     a droppable NORMAL chess is dropped, never the whole list; only a malformed list is BAD_MSG) and stored on the
//     session and the seat like the loadout. The match receives seats[].notOwned when it starts (bots: none — they own
//     every operator) and keeps it for its whole length: the setting is out of match ("局外设置，下一局生效"), so while
//     the room's match runs a new list is only stored for the next match (ROOM_STARTED 'stored for the next match',
//     never handed to the match). A spectator's list stays on its session.
//   * 自选编队 (0.2.0 DIY, the owner's decisions of 2026-10-05): room.diy { picks } — the player's picks for the four DIY
//     slots ({ [slotBaseId]: { charId, skillIndex?, uniEquipId? } | null }) — is checked leniently (shared/protocol.js
//     checkDiyPicks against the game data and the kit registry, server/sim/content/kits/index.js KITTED_CHARS: an
//     illegal pick — an operator without a kit, another tier's prototype, a prototype off its locked skill, a second slot
//     of one owned operator, the same operator twice in a tier, an unknown slot / skill / module — is dropped, never the
//     whole roster; only malformed picks are BAD_MSG) and stored on the session and the seat exactly like the
//     not-owned list: the match receives seats[].diy when it starts (bots: none — they field no 自选 piece [ASSUMED]),
//     and a change while it runs is stored for the next match (ROOM_STARTED 'stored for the next match'). Every
//     `welcome` carries `diyKitted` (welcomeInfo): the operators a DIY slot may field, so the client's picker offers
//     exactly what the server accepts.
//   * Spectator seats (community report #26, owner's decision 2026-10-04 — a remake feature, the official room has none):
//     room.spectate { code } takes one of a co-op room's MAX_SPECTATORS (2) spectator seats, in its lobby or while its
//     match runs (▸ solo rooms: ROOM_FULL). A spectator is not a player: never in `seats`, never counted for the 1–4 players
//     or the start gate, never host, never keeps a room alive (a room whose last human leaves closes with room.closed
//     {empty} for its spectators). It receives room.state (`spectators: [{ playerId, name, connected }]`) and every match
//     broadcast (m.public, m.ticker, m.emote, b.pool — public data); the match registers it (opts.spectators /
//     addSpectator) and shows it fields like an eliminated player (b.start watch / m.field), never an m.private. It may
//     only g.watch (the heavy bucket, like every watcher), g.leave / room.leave, and room.loadout / room.ownership /
//     room.diy (stored for its session, never handed to the match); anything else → SPECTATOR (▸ emotes too). Host: room.removeSpectator { playerId } any
//     time → room.closed {kicked} to it. A spectator in a LOBBY room may take a free player seat with room.join of the same
//     code; a player never switches to spectating in place (ALREADY). Disconnect / grace / reconnect / expiry work as for
//     a player seat (the seat is kept and given back on resume).

import { randomBytes, randomInt } from 'node:crypto';
import { ERR, MAX_SEATS, MAX_SPECTATORS, ROOM_CODE_LEN, modeIdFor } from '../shared/constants.js';
import { checkLoadout, checkNotOwned, checkDiyPicks } from '../shared/protocol.js';
import { encode, isDroppable, isErrCode, sendRaw, sendSession } from './net.js';
import { getData as defaultGetData, lookup } from './data.js';
import { Match as DefaultMatch } from './match/Match.js';
import { KITTED_CHARS } from './sim/content/kits/index.js';
import { canonicalOrigin, parseOriginList, pickShareOrigin } from '../shared/origin.js';

/** Room code alphabet: uppercase letters without I and O (and no digits, so no 0/1). */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Tunables. */
export const LOBBY_DEFAULTS = Object.freeze({
  lobbyGraceMs: 60_000,   // disconnected humans keep their lobby seat this long
  maxRooms: 1000,
  maxRoomsPerAddr: 16,    // rooms created from one client network that may exist at once (0 = unlimited)
  maxMatchesPerAddr: 8,   // matches started from one client network that may run at once (0 = unlimited)
  resyncMinGapMs: 1000,   // heavy resyncs (match state / result replay) per session at most this often on repeated hellos
  soloReconnectWindowMs: null, // a dropped solo run stays resumable this long (null = data singleReconnectTime, 24 h)
  publicOrigins: '',      // SP_PUBLIC_ORIGINS: pinned share-link origins (comma separated; EXCLUSIVE when set)
  shareLink: true,        // SP_SHARE_LINK=0: never answer share.link (the client uses its own location.origin)
  friendPushMs: 1000,     // at most one friend-presence push per account per this interval (coalesced)
  maxJoinFails: 12,       // invalid room codes one session may try per window before RATE
  joinFailWindowMs: 60_000,
});

/** Official `singleReconnectTime` (s) when the data lacks it (constData, research 01 §1). */
export const SOLO_RECONNECT_FALLBACK_SEC = 86_400;

/** Display names for AI teammates (the tutorial NPCs first, then a few familiar faces). */
export const BOT_NAMES = Object.freeze(['AI·华法琳', 'AI·阿米娅', 'AI·惊蛰', 'AI·杜宾', 'AI·凯尔希', 'AI·可露希尔']); // i18n-ignore: player names (docs/I18N.md)

const OK = Object.freeze({ ok: true });
const fail = (code, detail) => (detail ? { error: code, detail } : { error: code });
const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * @typedef {{ seat: number, playerId: string, name: string, isBot: boolean, ready: boolean,
 *             connected: boolean, left: boolean, loadout?: Record<string, { skill: number, module: string|null }> | null,
 *             notOwned?: readonly string[] | null, diy?: Readonly<Record<string, DiyLoadout>> | null }} Seat
 * @typedef {{ charId: string, skillIndex: number, uniEquipId: string|null }} DiyLoadout
 */

/** Deep-frozen copy of a checked loadout (shared by the session, the seat and the match's PlayerState). */
function freezeLoadout(loadout) {
  const out = {};
  for (const [id, e] of Object.entries(loadout || {})) out[id] = Object.freeze({ skill: e.skill, module: e.module ?? null });
  return Object.freeze(out);
}

/** Deep-frozen copy of checked 自选 picks (shared by the session, the seat and the match's PlayerState). */
function freezeDiy(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) out[id] = Object.freeze({ charId: p.charId, skillIndex: p.skillIndex, uniEquipId: p.uniEquipId ?? null });
  return Object.freeze(out);
}

/** One room: 4 seat slots, host, difficulty, optional running match. */
export class Room {
  /** @param {string} code @param {'solo'|'coop'} mode @param {string} difficulty @param {number} now */
  constructor(code, mode, difficulty, now) {
    this.code = code;
    this.mode = mode;
    this.difficulty = difficulty;
    /** @type {string | null} */
    this.hostId = null;
    /** @type {(Seat | null)[]} */
    this.seats = new Array(MAX_SEATS).fill(null);
    /** @type {{ playerId: string, name: string, connected: boolean }[]} spectator seats, ≤ MAX_SPECTATORS (header) */
    this.spectators = [];
    /** @type {any} running Match instance */
    this.match = null;
    /** @type {{ live: boolean, ended: boolean, disposed: boolean, match: any } | null} */
    this.matchCtx = null;
    this.matchCount = 0;
    /** @type {any} summary passed to onEnd by the last match */
    this.lastSummary = null;
    /**
     * Frames of the last match's end, replayed on resync to humans who have not moved on yet.
     * @type {{ publicFrame: string | null, frames: Map<string, string>, pending: Set<string> } | null}
     */
    this.replay = null;
    /** @type {string | null} per-network limit key of the creator (net.js clientAddress) */
    this.ownerKey = null;
    /** @type {string | null} per-network limit key of whoever started the running match */
    this.matchKey = null;
    /**
     * @type {boolean} 屏蔽好友 (DESIGN §27): the room is not shown in the creator's friends' presence lists — they see
     * only 'hidden'. An explicit invite still works (a deliberate act, not a broadcast). Set at creation.
     */
    this.hideFromFriends = false;
    this.createdAt = now;
    this.disposed = false;
  }

  /** @param {string} playerId @returns {Seat | null} */
  seatOf(playerId) {
    for (const s of this.seats) if (s && s.playerId === playerId) return s;
    return null;
  }

  /** @param {string} playerId @returns {{ playerId: string, name: string, connected: boolean } | null} */
  spectatorOf(playerId) { return this.spectators.find((s) => s.playerId === playerId) || null; }

  /** Lowest free seat index, or -1. */
  freeSeat() { return this.seats.indexOf(null); }

  /** Humans that have not departed, in seat order. @returns {Seat[]} */
  activeHumans() { return this.seats.filter((s) => s && !s.isBot && !s.left); }

  /** `room.state` frame (DESIGN §8.1) plus `inMatch`. */
  toState() {
    return {
      t: 'room.state',
      code: this.code,
      hostId: this.hostId,
      mode: this.mode,
      difficulty: this.difficulty,
      inMatch: !!this.match,
      seats: this.seats.map((s) => (s
        ? { seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, ready: s.ready, connected: s.connected && !s.left }
        : null)),
      spectators: this.spectators.map((s) => ({ playerId: s.playerId, name: s.name, connected: s.connected })),
    };
  }
}

/** Room registry + lobby message handlers. Pass an instance as the `handler` of net.js Network. */
export class Lobby {
  /**
   * @param {{
   *   registry: import('./net.js').SessionRegistry,
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   MatchClass?: new (opts: object) => any,
   *   getData?: () => object,
   *   now?: () => number,
   *   seedFn?: () => number,
   *   options?: Partial<typeof LOBBY_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, log = noopLog, MatchClass = DefaultMatch, getData = defaultGetData, now = Date.now, seedFn, accounts = null, options = {} }) {
    this.registry = registry;
    this.log = log;
    this.MatchClass = MatchClass;
    this.getData = getData;
    this.now = now;
    this.seedFn = seedFn || (() => randomInt(2 ** 32));
    this.opts = { ...LOBBY_DEFAULTS, ...options };
    /**
     * @type {import('./accounts.js').AccountStore | null} the account layer (DESIGN §27). null disables accounts,
     * friends and invites entirely: every social intent then answers ACCOUNT_REQUIRED and the room/lobby behave
     * exactly as before — which is what a deployment that does not want identity at all can choose.
     */
    this.accounts = accounts || null;
    /** @type {string[]} pinned share-link origins (SP_PUBLIC_ORIGINS); EXCLUSIVE when non-empty (shared/origin.js). */
    const allow = parseOriginList(this.opts.publicOrigins);
    this.shareOrigins = allow.origins;
    if (allow.invalid.length) this.log.warn(`[lobby] ignoring invalid SP_PUBLIC_ORIGINS entr${allow.invalid.length === 1 ? 'y' : 'ies'}: ${allow.invalid.join(', ')}`);
    if (this.shareOrigins.length) this.log.info(`[lobby] share links pinned to ${this.shareOrigins.join(', ')}`);
    /** @type {Map<string, NodeJS.Timeout>} coalesced friend-presence pushes by account id */
    this.friendPushTimers = new Map();
    /** @type {Map<string, number>} last friend-presence push per account id */
    this.friendPushAt = new Map();
    /** @type {Map<string, { n: number, at: number }>} invalid room-code attempts per playerId (brute-force guard) */
    this.joinFails = new Map();
    /** @type {Map<string, string>} last presence frame pushed per account (content dedupe) */
    this.presenceFrames = new Map();
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
    /** @type {Map<string, NodeJS.Timeout>} lobby grace timers by playerId */
    this.graceTimers = new Map();
    /** @type {Map<string, NodeJS.Timeout>} deferred (coalesced) resyncs by playerId */
    this.resyncTimers = new Map();
    /** per-network limit warnings: at most one log line per 10 s (the rest are counted) */
    this.limitLog = { at: -Infinity, suppressed: 0 };
  }

  /** @param {string} code @returns {Room | null} */
  getRoom(code) { return this.rooms.get(String(code).toUpperCase()) || null; }

  /** Counters for /healthz. */
  stats() {
    let matches = 0;
    let humans = 0;
    let bots = 0;
    let spectators = 0;
    for (const r of this.rooms.values()) {
      if (r.match) matches++;
      for (const s of r.seats) if (s && !s.left) (s.isBot ? bots++ : humans++);
      spectators += r.spectators.length;
    }
    return { rooms: this.rooms.size, matches, humans, bots, spectators };
  }

  // ---------------------------------------------------------------------------------------------------
  // net.js handler interface
  // ---------------------------------------------------------------------------------------------------

  /**
   * After `welcome`: resend room state / match state for resumed (or repeated) hellos.
   * @param {import('./net.js').Session} session
   * @param {{ resumed: boolean, repeat: boolean }} info
   */
  onHello(session, { resumed, repeat }) {
    // Accounts & friends (DESIGN §27): an account that comes online must reach its friends. A resume or a repeat hello
    // also resyncs the social snapshot, so a client that was away for a while (and missed friend.update / invite
    // frames) is correct again. A brand-new session that logged in through `hello.key` (a fresh tab with the cached
    // key) is online too — without this its friends would keep seeing it offline until it touched a room.
    if (session.accountId) {
      // the account name is authoritative: a keyless resume must not show an arbitrary hello nickname next to an id
      const account = this.accounts.get(session.accountId);
      if (account) session.name = account.name;
      if (resumed || repeat) this.sendFriendState(session);
      this.notifyFriends(session.accountId, true);
    }
    if (!resumed && !repeat) return;
    const room = this.roomOf(session);
    if (!room) {
      if (session.notice) {
        sendSession(session, { t: 'room.closed', reason: session.notice });
        session.notice = null;
      }
      if (session.pendingResult) {
        for (const frame of session.pendingResult) if (frame) sendRaw(session.ws, frame);
        session.pendingResult = null;
      }
      return;
    }
    session.notice = null;
    session.pendingResult = null;
    // a player seat, or a spectator seat (header): both carry `connected` / `name`
    const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
    this.clearGrace(session.playerId);
    // Only a visible change (reconnect, rename, new host) is broadcast; a plain resync (repeated hello on a
    // live socket) answers the requester alone, so hello spam cannot amplify into room-wide traffic.
    let changed = !seat.connected;
    seat.connected = true;
    if (!room.match && seat.name !== session.name) { seat.name = session.name; changed = true; }
    if (!room.hostId) { this.migrateHost(room); changed = true; }
    if (changed) this.broadcastState(room);
    else this.sendState(room, session);
    this.resync(session, !resumed);
  }

  /**
   * Validated client message from an identified session.
   * @param {import('./net.js').Session} session
   * @param {any} msg
   * @returns {{ ok: true } | { error: string, detail?: string }}
   */
  onMessage(session, msg) {
    switch (msg.t) {
      case 'room.create': return this.create(session, msg);
      case 'room.join': return this.join(session, msg);
      case 'room.leave': return this.leave(session);
      case 'room.ready': return this.ready(session, msg);
      case 'room.setDifficulty': return this.setDifficulty(session, msg);
      case 'room.addBot': return this.addBot(session);
      case 'room.removeBot': return this.removeBot(session, msg);
      case 'room.kick': return this.kick(session, msg);
      case 'room.start': return this.start(session);
      case 'room.loadout': return this.loadout(session, msg);
      case 'room.ownership': return this.ownership(session, msg);
      case 'room.diy': return this.diy(session, msg);
      case 'room.spectate': return this.spectate(session, msg);
      case 'room.removeSpectator': return this.removeSpectator(session, msg);
      // accounts & friends (DESIGN §27)
      case 'account.create': return this.accountCreate(session, msg);
      case 'account.login': return this.accountLogin(session, msg);
      case 'account.rename': return this.accountRename(session, msg);
      case 'account.rotate': return this.accountRotate(session);
      case 'account.logout': return this.accountLogout(session);
      case 'friend.request': return this.friendRequest(session, msg);
      case 'friend.accept': return this.friendAccept(session, msg);
      case 'friend.decline': return this.friendDecline(session, msg);
      case 'friend.remove': return this.friendRemove(session, msg);
      case 'friend.sync': return this.friendSync(session);
      case 'invite.send': return this.inviteSend(session, msg);
      case 'invite.accept': return this.inviteAccept(session, msg);
      case 'invite.decline': return this.inviteDecline(session, msg);
      case 'share.link': return this.shareLink(session);
      default:
        if (typeof msg.t === 'string' && msg.t.startsWith('g.')) return this.routeGame(session, msg);
        return fail(ERR.BAD_MSG, `unhandled type ${String(msg.t).slice(0, 32)}`);
    }
  }

  /** The session's socket closed. @param {import('./net.js').Session} session */
  onDisconnect(session) {
    this.clearResync(session.playerId); // the next resume resyncs immediately
    const room = this.roomOf(session);
    // a solo run may be resumed within singleReconnectTime (24 h); everything else keeps the registry's window
    session.resumeWindowMs = room && room.match && room.mode === 'solo' ? this.soloResumeWindowMs() : null;
    // friends see the account go offline (coalesced; a room-less player has no state broadcast to piggyback on)
    if (session.accountId) this.notifyFriends(session.accountId);
    if (!room) return;
    const player = room.seatOf(session.playerId);
    const seat = player || room.spectatorOf(session.playerId);
    seat.connected = false;
    // a spectator's seat is kept like a player's (nothing to tell the match: it plays no field)
    if (room.match) { if (player) this.callMatch(room, 'onDisconnect', session.playerId); } else this.startGrace(room, seat);
    this.broadcastState(room);
  }

  /** The session's reconnect window elapsed (already removed from the registry). */
  onExpire(session) {
    session.notice = null;
    session.pendingResult = null;
    this.clearResync(session.playerId);
    const code = session.roomCode;
    session.roomCode = null;
    const room = code ? this.rooms.get(code) : null;
    if (room) this.removeMember(room, session.playerId);
  }

  /**
   * Dispose every room (notifying members with room.closed) — used on server shutdown.
   * @param {string} [reason]
   */
  shutdown(reason = 'shutdown') {
    for (const room of [...this.rooms.values()]) this.disposeRoom(room, reason);
    for (const t of this.graceTimers.values()) clearTimeout(t);
    this.graceTimers.clear();
    for (const t of this.resyncTimers.values()) clearTimeout(t);
    this.resyncTimers.clear();
    for (const t of this.friendPushTimers.values()) clearTimeout(t);
    this.friendPushTimers.clear();
    this.joinFails.clear();
    this.presenceFrames.clear();
  }

  // ---------------------------------------------------------------------------------------------------
  // room.* handlers
  // ---------------------------------------------------------------------------------------------------

  create(session, { mode, difficulty, hidden }) {
    const cur = this.roomOf(session);
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (this.rooms.size >= this.opts.maxRooms) return fail(ERR.INTERNAL, 'too many rooms');
    const key = session.limitKey || null;
    if (key && this.opts.maxRoomsPerAddr > 0) {
      // The room being left disappears with this create when the creator is its only human (a spectator is none).
      const leaving = cur && cur.ownerKey === key && cur.activeHumans().length === 1 && !cur.spectatorOf(session.playerId) ? 1 : 0;
      if (this.countRooms((r) => r.ownerKey === key) - leaving >= this.opts.maxRoomsPerAddr) {
        this.limitWarn(`room limit (${this.opts.maxRoomsPerAddr}) reached for ${session.addr}`);
        return fail(ERR.RATE, 'too many rooms from your network');
      }
    }
    const code = this.genCode();
    if (!code) return fail(ERR.INTERNAL, 'no room code available');
    if (cur) this.removeMember(cur, session.playerId);
    const room = new Room(code, mode, difficulty, this.now());
    room.ownerKey = key;
    // 屏蔽好友 (the owner's requirement): the room is not shown in the creator's friends' lists — an explicit invite
    // still works, because that is a deliberate act rather than a broadcasting one
    room.hideFromFriends = !!hidden;
    room.seats[0] = this.humanSeat(0, session);
    room.hostId = session.playerId;
    this.rooms.set(code, room);
    session.roomCode = code;
    session.notice = null;
    session.pendingResult = null;
    this.log.info(`[lobby] ${code} created (${mode}/${difficulty}) by ${session.name}${hidden ? ' [hidden from friends]' : ''}`);
    this.broadcastState(room);
    this.notifyFriends(session.accountId);
    return OK;
  }

  join(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) {
      // Brute-force guard (DESIGN §27.1): a 4-letter code is short, so a failed join is counted per session; past the
      // window's budget the answer is RATE instead of ROOM_NOT_FOUND, which makes enumerating the code space useless.
      if (this.joinFailTooMany(session)) return fail(ERR.RATE, 'too many invalid alliance keys');
      return fail(ERR.ROOM_NOT_FOUND);
    }
    this.clearJoinFails(session.playerId);
    const cur = this.roomOf(session);
    // idempotent for members; a spectator of this room goes on below: it may take a free player seat (header)
    if (cur === room && !room.spectatorOf(session.playerId)) { this.sendState(room, session); return OK; }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.match) return fail(ERR.ROOM_STARTED);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    if (cur) this.removeMember(cur, session.playerId);
    room.seats[idx] = this.humanSeat(idx, session);
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    if (!room.hostId) room.hostId = session.playerId;
    this.broadcastState(room);
    this.notifyFriends(session.accountId);
    return OK;
  }

  /**
   * Count a failed room-code attempt; true when the session has burnt its budget for the window.
   * @param {import('./net.js').Session} session @returns {boolean}
   */
  joinFailTooMany(session) {
    const now = this.now();
    const cur = this.joinFails.get(session.playerId);
    if (!cur || now - cur.at > this.opts.joinFailWindowMs) {
      this.joinFails.set(session.playerId, { n: 1, at: now });
      this.trimJoinFails(now);
      return this.opts.maxJoinFails <= 0;
    }
    cur.n++;
    return cur.n > this.opts.maxJoinFails;
  }

  clearJoinFails(playerId) {
    if (this.joinFails.delete(playerId) && this.joinFails.size > 4096) this.trimJoinFails(this.now());
  }

  trimJoinFails(now) {
    if (this.joinFails.size < 4096) return;
    for (const [id, e] of this.joinFails) if (now - e.at > this.opts.joinFailWindowMs) this.joinFails.delete(id);
    if (this.joinFails.size >= 4096) {
      const old = [...this.joinFails.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 2048).map(([k]) => k);
      for (const k of old) this.joinFails.delete(k);
    }
  }

  leave(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    this.removeMember(room, session.playerId);
    return OK;
  }

  /**
   * room.spectate: one of a co-op room's MAX_SPECTATORS spectator seats, in its lobby or during its match (header). In a
   * running match the match registers the spectator and resends what it may see (Match.addSpectator).
   */
  spectate(session, { code }) {
    const norm = String(code).trim().toUpperCase();
    const room = norm.length === ROOM_CODE_LEN ? this.rooms.get(norm) : undefined;
    if (!room) {
      // same brute-force guard as `join`: spectating must not be a cheaper oracle for the 4-letter code space
      if (this.joinFailTooMany(session)) return fail(ERR.RATE, 'too many invalid alliance keys');
      return fail(ERR.ROOM_NOT_FOUND);
    }
    this.clearJoinFails(session.playerId);
    const cur = this.roomOf(session);
    if (cur === room) {
      if (!room.spectatorOf(session.playerId)) return fail(ERR.ALREADY, 'seated as a player');
      this.sendState(room, session);
      return OK;
    }
    if (cur && cur.match) return fail(ERR.ROOM_STARTED, 'leave your running match first');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.spectators.length >= MAX_SPECTATORS) return fail(ERR.ROOM_FULL, 'no free spectator seat');
    if (cur) this.removeMember(cur, session.playerId);
    room.spectators.push({ playerId: session.playerId, name: session.name, connected: session.connected });
    session.roomCode = room.code;
    session.notice = null;
    session.pendingResult = null;
    this.broadcastState(room);
    if (room.match) this.callMatch(room, 'addSpectator', session.playerId);
    return OK;
  }

  /** room.removeSpectator (host, any time): the spectator gets room.closed {kicked} and its seat is freed. */
  removeSpectator(session, { playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (!room.spectatorOf(playerId)) return fail(ERR.BAD_TARGET, 'not a spectator of this room');
    const target = this.registry.byId(playerId);
    const wasHere = !!target && target.roomCode === room.code;
    const replay = this.replayFor(room, playerId);
    this.removeMember(room, playerId);
    if (wasHere) {
      // like room.kick: now, or on the next resume (with the result replay, as after the grace timeout)
      if (target.connected) sendSession(target, { t: 'room.closed', reason: 'kicked' });
      else { target.notice = 'kicked'; target.pendingResult = replay; }
    }
    return OK;
  }

  ready(session, { ready }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const seat = room.seatOf(session.playerId);
    if (seat.ready !== ready) {
      seat.ready = ready;
      this.broadcastState(room);
    }
    return OK;
  }

  setDifficulty(session, { difficulty }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.difficulty !== difficulty) {
      room.difficulty = difficulty;
      for (const s of room.seats) if (s && !s.isBot && s.playerId !== room.hostId) s.ready = false;
      this.broadcastState(room);
    }
    return OK;
  }

  addBot(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo rooms cannot have AI teammates');
    const idx = room.freeSeat();
    if (idx < 0) return fail(ERR.ROOM_FULL);
    const used = new Set(room.seats.filter((s) => s && s.isBot).map((s) => s.name));
    const name = BOT_NAMES.find((n) => !used.has(n)) || `AI·${idx + 1}`;
    let playerId;
    do playerId = 'ai_' + randomBytes(4).toString('hex'); while (room.seatOf(playerId));
    room.seats[idx] = { seat: idx, playerId, name, isBot: true, ready: true, connected: true, left: false };
    this.broadcastState(room);
    return OK;
  }

  removeBot(session, { seat }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || !target.isBot) return fail(ERR.BAD_TARGET, 'seat does not hold an AI');
    room.seats[seat] = null;
    this.broadcastState(room);
    return OK;
  }

  /** Host removes another human before the match (header: room.kick). */
  kick(session, { seat, playerId }) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    this.dropReplay(room, session.playerId);
    const target = room.seats[seat];
    if (!target || target.left) return fail(ERR.BAD_TARGET, 'seat holds no player');
    if (target.playerId !== playerId) return fail(ERR.BAD_TARGET, 'seat changed hands'); // the confirmed player left meanwhile
    if (target.isBot) return fail(ERR.BAD_TARGET, 'seat holds an AI (room.removeBot)');
    if (target.playerId === session.playerId) return fail(ERR.BAD_TARGET, 'cannot kick yourself');
    const kicked = this.registry.byId(target.playerId);
    const wasHere = !!kicked && kicked.roomCode === room.code;
    const replay = this.replayFor(room, target.playerId);
    this.removeMember(room, target.playerId);
    if (wasHere) {
      if (kicked.connected) sendSession(kicked, { t: 'room.closed', reason: 'kicked' });
      else { kicked.notice = 'kicked'; kicked.pendingResult = replay; }
    }
    this.log.info(`[lobby] ${room.code} ${target.name} removed by the host`);
    return OK;
  }

  start(session) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.hostId !== session.playerId) return fail(ERR.NOT_HOST);
    if (room.match) return fail(ERR.ROOM_STARTED);
    const humans = room.activeHumans();
    for (const s of humans) {
      if (s.playerId !== room.hostId && (!s.connected || !s.ready)) return fail(ERR.NOT_READY);
    }
    const bots = room.seats.filter((s) => s && s.isBot);
    if (humans.length < 1 || (room.mode === 'solo' && (humans.length !== 1 || bots.length > 0))) {
      return fail(ERR.BAD_MSG, 'invalid seat configuration');
    }
    const key = session.limitKey || null;
    if (key && this.opts.maxMatchesPerAddr > 0 && this.countRooms((r) => !!r.match && r.matchKey === key) >= this.opts.maxMatchesPerAddr) {
      this.limitWarn(`match limit (${this.opts.maxMatchesPerAddr}) reached for ${session.addr}`);
      return fail(ERR.RATE, 'too many running matches from your network');
    }
    return this.startMatch(room, key);
  }

  /**
   * room.loadout (DESIGN §16): check the operator loadout against the game data, store it on the session and the seat,
   * and — while a match runs — hand it to the match (accepted only during INFO_CHECK, see the header).
   */
  loadout(session, { entries }) {
    const data = this.safeData();
    const res = checkLoadout(entries, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(res && isErrCode(res.error) ? res.error : ERR.BAD_MSG, res && res.detail);
    const loadout = freezeLoadout(res.loadout);
    session.loadout = loadout;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.loadout = loadout;
    if (!room.match || !seat) return OK; // a spectator's loadout stays on its session, never reaching the match
    if (typeof room.match.setLoadout !== 'function') return fail(ERR.ROOM_STARTED, 'stored for the next match');
    let r;
    try {
      r = room.match.setLoadout(session.playerId, loadout);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.setLoadout threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (r && typeof r === 'object' && r.error) {
      return fail(isErrCode(r.error) ? r.error : ERR.INTERNAL, typeof r.detail === 'string' ? r.detail : undefined);
    }
    return OK;
  }

  /**
   * room.ownership (0.2.0 补位): keep the droppable chess of the not-owned list, store it on the session and the seat
   * (see the header). A running match never takes it: it keeps the list its seat had at its start.
   */
  ownership(session, { notOwned }) {
    const data = this.safeData();
    const res = checkNotOwned(notOwned, (id) => lookup('chess', id, data));
    if (!res || res.error) return fail(ERR.BAD_MSG, res && res.detail);
    const list = Object.freeze(res.notOwned.slice());
    session.notOwned = list;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.notOwned = list;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /**
   * room.diy (0.2.0 自选编队): keep the legal picks (checkDiyPicks against the data and KITTED_CHARS), store them on the
   * session and the seat (see the header). A running match never takes them: it keeps the picks its seat had at its
   * start.
   */
  diy(session, { picks }) {
    const res = checkDiyPicks(picks, { data: this.safeData(), kitted: KITTED_CHARS });
    if (!res || !('ok' in res)) return fail(ERR.BAD_MSG, res && res.detail);
    const kept = freezeDiy(res.picks);
    session.diy = kept;
    const room = this.roomOf(session);
    if (!room) return OK;
    const seat = room.seatOf(session.playerId);
    if (seat) seat.diy = kept;
    if (room.match && seat) return fail(ERR.ROOM_STARTED, 'stored for the next match');
    return OK;
  }

  /** Extra fields of every `welcome` (net.js): the operators a 自选 slot may field (shared/diy.js `kitted`). */
  welcomeInfo(session) {
    return {
      diyKitted: KITTED_CHARS,
      // share-link origin for this connection only (DESIGN §27.1) — never broadcast, never another player's
      shareOrigin: session ? session.shareOrigin : null,
      // the account this session is logged in as (so the title screen can greet before the first request)
      account: session && session.accountId ? this.accountProfile(session.accountId) : null,
      // the reason a presented key was refused (ACCOUNT_BAD_KEY / RATE / INTERNAL) — the client prompts for a new key
      accountError: session ? session.accountError || undefined : undefined,
    };
  }

  // ---------------------------------------------------------------------------------------------------
  // Accounts & friends (DESIGN §27)
  //
  // The rules live in server/accounts.js; this section is the wire + room side of them:
  //   * binding a key to a session (hello.key / account.login), including the per-session failure throttle;
  //   * the social snapshot (friend.state) and its increments (friend.request / friend.update / friend.remove /
  //     invite / invite.done), pushed only to the accounts they concern;
  //   * presence derived from the rooms this lobby owns — the one thing the account store cannot know;
  //   * the share-link origin (SP_PUBLIC_ORIGINS + the connection origin).
  // ---------------------------------------------------------------------------------------------------

  /** The public shape of an account by id, or null. @returns {{ accountId: string, name: string } | null} */
  accountProfile(accountId) {
    if (!this.accounts || !accountId) return null;
    return this.accounts.profile(this.accounts.get(accountId));
  }

  /** The account record of a session (null for a guest or when accounts are off). */
  accountOf(session) {
    if (!this.accounts || !session || !session.accountId) return null;
    return this.accounts.get(session.accountId);
  }

  /**
   * `hello.key` / `account.login`: prove a key and bind the session to the account. The account name is authoritative
   * over the title-screen nickname (one name, editable through account.rename), so a resume cannot drift from it.
   * @param {import('./net.js').Session} session @param {unknown} key
   * @returns {{ error: string } | null}
   */
  bindAccount(session, key) {
    if (!this.accounts) return { error: ERR.ACCOUNT_REQUIRED };
    if (!this.accounts.login) return { error: ERR.INTERNAL };
    // No key at all: a token resume keeps the account it already had (a plain reconnect never logs anyone out), but
    // the account name is authoritative, so a hello nickname cannot make the id show up under another name.
    if (key == null || key === '') {
      const held = session.accountId ? this.accounts.get(session.accountId) : null;
      if (held) session.name = held.name;
      return null;
    }
    const now = this.now();
    // Failure throttle: a socket may present at most maxJoinFails wrong keys per window; after that we stop hashing.
    if (session.authFailsAt && now - session.authFailsAt > this.opts.joinFailWindowMs) session.authFails = 0;
    session.authFailsAt = now;
    if (session.authFails >= this.opts.maxJoinFails) return { error: ERR.RATE };
    const res = this.accounts.login(key);
    if (!res.ok) { session.authFails++; return { error: res.error }; }
    session.authFails = 0;
    const previous = session.accountId;
    session.accountId = res.account.id;
    session.name = res.account.name;
    this.accounts.touch(res.account);
    if (previous !== res.account.id) this.log.info(`[lobby] ${session.addr} logged in as ${res.account.id} (${res.account.name})`);
    // switching accounts on one session: the account left behind is offline now (unless another session holds it)
    if (previous && previous !== res.account.id) this.notifyFriends(previous);
    // keep an existing seat's visible name in step (LOBBY only, exactly like a reconnect rename)
    const room = this.roomOf(session);
    if (room && !room.match) {
      const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
      if (seat && seat.name !== session.name) { seat.name = session.name; this.broadcastState(room); }
    }
    return null;
  }

  /**
   * The share-link origin of a connection (DESIGN §27.1, shared/origin.js). Never throws, never trusts blindly:
   * the reported origin must be the allowlisted one (when an allowlist is configured) or this connection's own origin.
   * @param {import('./net.js').Session} session @param {string | null} reported @param {string | null} connOrigin
   * @returns {string | null}
   */
  resolveOrigin(session, reported, connOrigin) {
    if (this.opts.shareLink === false) return null;
    const clean = typeof reported === 'string' ? canonicalOrigin(reported) : null;
    return pickShareOrigin({ reported: clean, connOrigin: connOrigin || null, allow: this.shareOrigins });
  }

  /**
   * `share.link`: the canonical link for the session's current room. The reply flows through the `ok` payload
   * (server/net.js merges `res.payload` into the ok frame) so the client gets a link it can put on the clipboard.
   * `source` tells the client where the origin came from: 'allowlist' (pinned by the operator), 'connection' (the
   * address this player used), or 'none' (no server opinion — the client builds the link from location.origin).
   */
  shareLink(session) {
    const origin = session.shareOrigin || null;
    const room = this.roomOf(session);
    const code = room ? room.code : null;
    const source = !origin ? 'none' : this.shareOrigins.length ? 'allowlist' : 'connection';
    const url = origin && code ? `${origin}/?room=${encodeURIComponent(code)}` : (origin ? `${origin}/` : null);
    return { ok: true, payload: { origin, url, code, source } };
  }

  /** `account.create`: mint an account for this session (the key is returned once) and bind it. */
  accountCreate(session, { name }) {
    if (!this.accounts) return fail(ERR.ACCOUNT_REQUIRED);
    if (session.accountId) return fail(ERR.ALREADY, 'this session already has an account');
    const res = this.accounts.create({ name, addrKey: session.limitKey || null });
    if (!res.ok) return fail(res.error, res.detail);
    session.accountId = res.account.id;
    session.name = res.account.name;
    const room = this.roomOf(session);
    if (room && !room.match) {
      const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
      if (seat) { seat.name = session.name; this.broadcastState(room); }
    }
    this.sendAccountState(session, { key: res.key });
    this.sendFriendState(session);
    this.notifyFriends(session.accountId);
    this.log.info(`[lobby] account ${res.account.id} (${res.account.name}) created for ${session.addr}`);
    return OK;
  }

  /** `account.login`: switch this session to an account (or re-login after a lost key). */
  accountLogin(session, { key }) {
    if (!this.accounts) return fail(ERR.ACCOUNT_REQUIRED);
    const err = this.bindAccount(session, key);
    if (err) return fail(err.error);
    this.sendAccountState(session);
    this.sendFriendState(session);
    this.notifyFriends(session.accountId);
    return OK;
  }

  /** `account.rename`: the account name is the single visible name (seat, friends, invites). */
  accountRename(session, { name }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.rename(account, name);
    if (!res.ok) return fail(res.error, res.detail);
    session.name = res.account.name;
    const room = this.roomOf(session);
    if (room && !room.match) {
      const seat = room.seatOf(session.playerId) || room.spectatorOf(session.playerId);
      if (seat) { seat.name = session.name; this.broadcastState(room); }
    }
    this.sendAccountState(session);
    this.sendFriendState(session);
    this.notifyFriends(session.accountId, true);
    return OK;
  }

  /**
   * `account.rotate`: mint a new key and drop every OTHER live session of this account (a rotated key must not keep
   * working for a socket that may have been stolen). The caller keeps its session and receives the new key once.
   */
  accountRotate(session) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.rotate(account);
    if (!res.ok) return fail(res.error);
    let dropped = 0;
    for (const s of this.registry.all()) {
      if (s === session || s.accountId !== account.id) continue;
      s.accountId = null;
      s.accountError = ERR.ACCOUNT_BAD_KEY;
      dropped++;
      try { s.ws?.close(4004, 'account key rotated'); } catch { /* ignore */ }
    }
    this.sendAccountState(session, { key: res.key });
    if (dropped) this.log.info(`[lobby] rotation of ${account.id} dropped ${dropped} other session(s)`);
    return OK;
  }

  /**
   * `account.logout`: this session stops using the account. The key stays valid (only `account.rotate` kills a key) —
   * this is the "shared computer" / "hand the laptop over" button. The guest keeps its nickname and its seat.
   */
  accountLogout(session) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    session.accountId = null;
    this.sendAccountState(session);
    // the account is offline as far as its friends are concerned (unless another session is still logged in)
    this.notifyFriends(account.id, true);
    return OK;
  }

  /** The `account.state` push: `{ account, key? }` — the key only ever rides on create/rotate. */
  sendAccountState(session, extra) {
    const profile = this.accountProfile(session.accountId);
    const msg = { t: 'account.state', account: profile, key: extra && extra.key ? extra.key : undefined };
    sendSession(session, msg);
  }

  /** `friend.request` — only a played-together partner may be asked (server/accounts.js NOT_ELIGIBLE otherwise). */
  friendRequest(session, { accountId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.requestFriend(account, accountId);
    if (!res.ok) return fail(res.error, res.detail);
    if (res.accepted) {
      // a mutual request went straight through: both sides get the new snapshot and each other's presence
      this.sendFriendState(session);
      this.sendToAccount(accountId, { t: 'friend.state', ...this.friendSnapshot(accountId) });
      this.notifyFriends(account.id, true);
      this.notifyFriends(accountId, true);
      this.log.info(`[lobby] ${account.id} <-> ${accountId} friends (mutual request)`);
      return OK;
    }
    this.sendFriendState(session);
    this.sendToAccount(accountId, { t: 'friend.request', accountId: account.id, name: account.name, at: this.now() });
    return OK;
  }

  friendAccept(session, { accountId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.acceptFriend(account, accountId);
    if (!res.ok) return fail(res.error, res.detail);
    this.sendFriendState(session);
    this.sendToAccount(accountId, { t: 'friend.state', ...this.friendSnapshot(accountId) });
    this.notifyFriends(account.id, true);
    this.notifyFriends(accountId, true);
    return OK;
  }

  friendDecline(session, { accountId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.declineFriend(account, accountId);
    if (!res.ok) return fail(res.error, res.detail);
    this.sendFriendState(session);
    this.sendToAccount(accountId, { t: 'friend.state', ...this.friendSnapshot(accountId) });
    return OK;
  }

  friendRemove(session, { accountId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const other = this.accounts.get(accountId);
    const res = this.accounts.removeFriend(account, accountId);
    if (!res.ok) return fail(res.error, res.detail);
    this.sendFriendState(session);
    this.sendToAccount(accountId, { t: 'friend.remove', accountId: account.id, name: account.name });
    this.sendToAccount(accountId, { t: 'friend.state', ...this.friendSnapshot(accountId) });
    if (other) this.log.info(`[lobby] ${account.id} removed ${other.id} from friends`);
    return OK;
  }

  /** `friend.sync`: resend the whole social snapshot (after login, a resume, or a client-side reset). */
  friendSync(session) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    this.sendFriendState(session);
    return OK;
  }

  sendFriendState(session) {
    if (!session.accountId) return;
    sendSession(session, { t: 'friend.state', ...this.friendSnapshot(session.accountId) });
  }

  /**
   * `invite.send`: ask the server to deliver an invitation to the room this session is in to one friend. The invite is
   * minted by the store (bound to the recipient, expiring) and pushed to every live session of that account.
   */
  inviteSend(session, { accountId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (room.match) return fail(ERR.ROOM_STARTED, 'the match already started');
    if (room.mode === 'solo') return fail(ERR.ROOM_FULL, 'solo room');
    if (room.freeSeat() < 0) return fail(ERR.ROOM_FULL);
    if (room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    const res = this.accounts.createInvite(account, accountId, {
      code: room.code, mode: room.mode, difficulty: room.difficulty, players: room.activeHumans().length,
    });
    if (!res.ok) return fail(res.error, res.detail);
    const delivered = this.sendToAccount(accountId, { t: 'invite', ...res.invite });
    if (delivered === 0) {
      // the friend is offline: the invite stays valid until it expires (they may resume within the window)
      this.log.info(`[lobby] invite ${res.invite.id} queued for offline ${accountId}`);
    }
    return OK;
  }

  /**
   * `invite.accept`: consume the invite and join through the same gates as `room.join` (mode, seat, not started) —
   * an invite can never bypass a room's rules, it only saves typing the code. The sender is told the outcome.
   */
  inviteAccept(session, { inviteId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.takeInvite(account.id, inviteId);
    if (!res.ok) return fail(res.error);
    const invite = res.invite;
    const joined = this.join(session, { code: invite.code });
    if (joined.error) {
      this.sendToAccount(invite.from, { t: 'invite.done', inviteId: invite.inviteId, ok: false, reason: joined.error });
      return joined;
    }
    this.sendToAccount(invite.from, { t: 'invite.done', inviteId: invite.inviteId, ok: true, by: account.name });
    this.notifyFriends(account.id, true);
    return OK;
  }

  inviteDecline(session, { inviteId }) {
    const account = this.accountOf(session);
    if (!account) return fail(ERR.ACCOUNT_REQUIRED);
    const res = this.accounts.declineInvite(account.id, inviteId);
    if (!res.ok) return fail(res.error);
    this.sendToAccount(res.invite.from, { t: 'invite.done', inviteId: res.invite.inviteId, ok: false, declined: true });
    return OK;
  }

  /**
   * The whole social snapshot for one account: who is online and where, pending requests both ways, the met list (the
   * only addable people) and the pending invites. A friend's room is included only when they did not hide it.
   */
  friendSnapshot(accountId) {
    const account = this.accounts ? this.accounts.get(accountId) : null;
    if (!account) return { account: null, friends: [], incoming: [], outgoing: [], met: [], invites: [] };
    const index = this.accountSessionIndex();
    const friends = [];
    for (const id of account.friends) {
      const presence = this.presenceOf(id, index);
      if (presence) friends.push(presence);
    }
    friends.sort((a, b) => (a.online === b.online ? a.name.localeCompare(b.name) : a.online ? -1 : 1));
    const pairs = (set) => [...set].map((id) => {
      const other = this.accounts.get(id);
      return other ? { accountId: other.id, name: other.name } : null;
    }).filter(Boolean);
    return {
      account: { accountId: account.id, name: account.name },
      friends,
      incoming: pairs(account.incoming),
      outgoing: pairs(account.outgoing),
      met: this.accounts.metList(account),
      invites: this.accounts.invitesFor(accountId),
    };
  }

  /**
   * Where an account is right now, as its friends see it. `status`:
   *   'offline'  no live session
   *   'idle'     online, not in a room
   *   'lobby'    in a room whose match has not started (joinable when a seat is free)
   *   'match'    in a running match (only watching is possible)
   *   'hidden'   in a room created with 屏蔽好友 — friends learn nothing but "not available"
   * The room (code / difficulty / occupancy) is included only when it is not hidden: a room code is the ability to
   * join, so it is never leaked past a friend's own list, and never for a hidden room.
   * @returns {{ accountId: string, name: string, online: boolean, status: string, room: object | null } | null}
   */
  /**
   * Live sessions per account id. The registry is a flat list, so a presence push, a snapshot or a targeted frame would
   * otherwise cost O(sessions) each; one index per operation keeps the social layer independent of server size.
   * @returns {Map<string, import('./net.js').Session[]>}
   */
  accountSessionIndex() {
    const index = new Map();
    for (const s of this.registry.all()) {
      if (!s.accountId || !s.connected) continue;
      const list = index.get(s.accountId);
      if (list) list.push(s);
      else index.set(s.accountId, [s]);
    }
    return index;
  }

  presenceOf(accountId, index = null) {
    const account = this.accounts ? this.accounts.get(accountId) : null;
    if (!account) return null;
    const sessions = (index || this.accountSessionIndex()).get(accountId) || [];
    let anyOnline = sessions.length > 0;
    let room = null;
    for (const s of sessions) {
      room = this.roomOf(s);
      if (room) break;
    }
    const base = { accountId: account.id, name: account.name, online: anyOnline, status: 'idle', room: null };
    if (!anyOnline) return { ...base, status: 'offline' };
    if (!room) return base;
    if (room.hideFromFriends) return { ...base, status: 'hidden' };
    // A solo run is nobody's business: it cannot be joined or watched, so only the fact of it is shared.
    if (room.mode === 'solo') return { ...base, status: 'solo' };
    return {
      ...base,
      status: room.match ? 'match' : 'lobby',
      room: {
        code: room.code, mode: room.mode, difficulty: room.difficulty,
        players: room.activeHumans().length,
        joinable: !room.match && room.freeSeat() >= 0,
        spectatable: room.spectators.length < MAX_SPECTATORS,
      },
    };
  }

  /** Push one frame to every live session logged in as `accountId`. @returns {number} sessions reached */
  sendToAccount(accountId, msg, index = null) {
    if (!this.accounts || !accountId) return 0;
    const list = (index || this.accountSessionIndex()).get(accountId);
    if (!list || list.length === 0) return 0;
    let n = 0;
    for (const s of list) if (s.connected && s.ws && sendSession(s, msg)) n++;
    return n;
  }

  /**
   * Tell an account's online friends where it is now. Coalesced per account (friendPushMs): a player toggling ready
   * and switching seats must not turn into a push storm on their friends' sockets. force=true skips the throttle
   * (a relationship or name change must be seen immediately).
   */
  notifyFriends(accountId, force = false) {
    if (!this.accounts || !accountId) return;
    const account = this.accounts.get(accountId);
    if (!account || account.friends.size === 0) return;
    const last = this.friendPushAt.get(accountId);
    const wait = typeof last === 'number' ? last + this.opts.friendPushMs - this.now() : 0;
    if (!force && wait > 0) {
      if (this.friendPushTimers.has(accountId)) return;
      const t = setTimeout(() => {
        this.friendPushTimers.delete(accountId);
        this.pushPresence(accountId);
      }, wait);
      t.unref?.();
      this.friendPushTimers.set(accountId, t);
      return;
    }
    this.pushPresence(accountId);
  }

  /** @param {string} accountId */
  pushPresence(accountId) {
    if (!this.accounts) return;
    const account = this.accounts.get(accountId);
    if (!account) return;
    this.friendPushAt.set(accountId, this.now());
    if (this.friendPushAt.size > 4096) {
      // bounded: drop the oldest half (only used as a throttle timestamp)
      const old = [...this.friendPushAt.entries()].sort((a, b) => a[1] - b[1]).slice(0, 2048).map(([k]) => k);
      for (const k of old) this.friendPushAt.delete(k);
    }
    const entry = this.presenceOf(accountId);
    if (!entry) return;
    // Content dedupe: a ready toggle rebroadcasts the room but changes nothing a friend can see. Keeping the last
    // frame per account means friends hear about status changes only (and never twice).
    const frame = JSON.stringify(entry);
    if (this.presenceFrames.get(accountId) === frame) return;
    this.presenceFrames.set(accountId, frame);
    if (this.presenceFrames.size > 4096) {
      const old = [...this.presenceFrames.keys()].slice(0, 2048);
      for (const k of old) this.presenceFrames.delete(k);
    }
    const index = this.accountSessionIndex();
    for (const fid of account.friends) this.sendToAccount(fid, { t: 'friend.update', ...entry }, index);
  }

  /** The account ids of the human players in a room (bots and spectators excluded) — the match ledger input. */
  accountIdsOf(room) {
    const out = [];
    for (const s of room.seats) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.accountId) out.push(session.accountId);
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------------
  // Match wiring
  // ---------------------------------------------------------------------------------------------------

  /** @param {Room} room @param {string | null} [key] per-network limit key of the starter */
  startMatch(room, key = null) {
    const host = room.seatOf(room.hostId);
    if (host) host.ready = true;
    const seats = room.seats.filter(Boolean).map((s) => ({
      seat: s.seat, playerId: s.playerId, name: s.name, isBot: s.isBot, connected: s.connected,
      // DESIGN §16: the human's checked operator loadout (bots fight with the defaults)
      loadout: s.isBot ? null : s.loadout || null,
      // 0.2.0 补位: the chess the human marked as not owned (bots own every operator)
      notOwned: s.isBot ? null : s.notOwned || null,
      // 0.2.0 自选编队: the human's checked DIY picks (bots field no 自选 piece [ASSUMED])
      diy: s.isBot ? null : s.diy || null,
    }));
    // lastPublic / results: the latest m.public broadcast and the m.result frames (encoded), kept for the replay.
    const ctx = { live: true, ended: false, disposed: false, match: null, lastPublic: null, sharedResult: null, results: new Map() };
    let seed = 0;
    try { seed = this.seedFn() >>> 0; } catch { seed = randomInt(2 ** 32); }
    try {
      const match = new this.MatchClass({
        roomCode: room.code,
        mode: room.mode,
        difficulty: room.difficulty,
        modeId: modeIdFor(room.mode, room.difficulty),
        seats,
        // the spectator seats (header): watched like eliminated players, never players
        spectators: room.spectators.map((s) => s.playerId),
        seed,
        // the room's match number: with the seed it keeps battleIds unique across the room's matches (DESIGN §14)
        matchNo: room.matchCount + 1,
        data: this.safeData(),
        log: this.log,
        now: this.now,
        send: (playerId, msg) => (ctx.live ? this.matchSend(room, ctx, playerId, msg) : false),
        broadcast: (msg) => { if (ctx.live) this.matchBroadcast(room, ctx, msg); },
        onEnd: (summary) => this.onMatchEnd(room, ctx, summary),
      });
      ctx.match = match;
      room.match = match;
      room.matchCtx = ctx;
      room.matchKey = key;
      room.replay = null;
      room.matchCount++;
      this.log.info(`[lobby] ${room.code} match #${room.matchCount} starting (${room.mode}/${room.difficulty}, ${seats.length} seats, seed ${seed})`);
      // The "played together" ledger (DESIGN §27): the humans who entered this match may become friends afterwards.
      // Recorded here, at the start of a match both sides are in — the friend rule is "played together", and a match
      // that starts always produces combat. Bots, spectators and departed players are not part of it.
      if (this.accounts) this.accounts.recordPlayed(this.accountIdsOf(room));
      this.broadcastState(room);
      match.start();
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match failed to start`, e);
      if (room.matchCtx === ctx) { room.match = null; room.matchCtx = null; room.matchKey = null; }
      this.disposeMatchCtx(ctx);
      this.broadcastState(room);
      return fail(ERR.INTERNAL, 'match failed to start');
    }
    return OK;
  }

  /** onEnd callback: return the room to LOBBY and dispose the match on the next macrotask. */
  onMatchEnd(room, ctx, summary) {
    if (ctx.ended || !ctx.live || room.matchCtx !== ctx || room.disposed) return;
    ctx.ended = true;
    room.lastSummary = summary ?? null;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = this.buildReplay(room, ctx);
    setImmediate(() => this.disposeMatchCtx(ctx));
    this.log.info(`[lobby] ${room.code} match #${room.matchCount} ended`);
    for (let i = 0; i < room.seats.length; i++) {
      const s = room.seats[i];
      if (!s || s.isBot) continue;
      if (s.left) { room.seats[i] = null; continue; }
      s.ready = false;
      if (!s.connected) this.startGrace(room, s);
    }
    for (const s of room.spectators) if (!s.connected) this.startGrace(room, s);
    const host = room.hostId ? room.seatOf(room.hostId) : null;
    if (!host || host.isBot || host.left) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /** Match unicast; m.result frames are also kept for the replay. */
  matchSend(room, ctx, playerId, msg) {
    if (msg && msg.t === 'm.result') {
      const data = encode(msg);
      if (data != null) ctx.results.set(playerId, data);
    }
    return this.sendToPlayer(room, playerId, msg);
  }

  /** Match broadcast; the latest m.public and a broadcast m.result are also kept for the replay. */
  matchBroadcast(room, ctx, msg) {
    const data = this.broadcastRoom(room, msg);
    if (data == null) return;
    if (msg.t === 'm.public') ctx.lastPublic = data;
    else if (msg.t === 'm.result') ctx.sharedResult = data;
  }

  /**
   * Replay record for the humans still seated when a match ends (null when the match produced no m.result,
   * e.g. it was abandoned: those clients then see "simulation closed").
   * @param {Room} room @returns {Room['replay']}
   */
  buildReplay(room, ctx) {
    const frames = new Map();
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const frame = ctx.results.get(s.playerId) || ctx.sharedResult;
      if (frame) frames.set(s.playerId, frame);
    }
    if (frames.size === 0) return null;
    return { publicFrame: ctx.lastPublic, frames, pending: new Set(frames.keys()) };
  }

  /** The replay frames still owed to a player (null when they moved on). @returns {string[] | null} */
  replayFor(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.has(playerId)) return null;
    return [r.publicFrame, r.frames.get(playerId)].filter(Boolean);
  }

  /** The player moved on from the result screen (acted in the room, left): stop replaying it. */
  dropReplay(room, playerId) {
    const r = room.replay;
    if (!r || !r.pending.delete(playerId)) return;
    r.frames.delete(playerId);
    if (r.pending.size === 0) room.replay = null;
  }

  /**
   * The heavy part of a resync — full match state (match.onReconnect) or, back in LOBBY, the result replay.
   * Immediate after a (re)connect; for repeated hellos on a live socket at most once per resyncMinGapMs
   * (requests inside the window coalesce into one deferred resync).
   * @param {import('./net.js').Session} session @param {boolean} coalesce
   */
  resync(session, coalesce) {
    const pid = session.playerId;
    if (coalesce) {
      if (this.resyncTimers.has(pid)) return; // the scheduled resync answers this request too
      const wait = (Number.isFinite(session.resyncAt) ? session.resyncAt : -Infinity) + this.opts.resyncMinGapMs - this.now();
      if (wait > 0) {
        const t = setTimeout(() => { this.resyncTimers.delete(pid); this.runResync(session); }, wait);
        t.unref?.();
        this.resyncTimers.set(pid, t);
        return;
      }
    } else {
      this.clearResync(pid);
    }
    this.runResync(session);
  }

  /** @param {import('./net.js').Session} session */
  runResync(session) {
    if (!session.connected || this.registry.byId(session.playerId) !== session) return;
    const room = this.roomOf(session);
    if (!room) return;
    session.resyncAt = this.now();
    if (room.match) {
      this.callMatch(room, room.spectatorOf(session.playerId) ? 'addSpectator' : 'onReconnect', session.playerId);
      return;
    }
    const frames = this.replayFor(room, session.playerId);
    if (frames) for (const frame of frames) sendRaw(session.ws, frame);
  }

  clearResync(playerId) {
    const t = this.resyncTimers.get(playerId);
    if (t) { clearTimeout(t); this.resyncTimers.delete(playerId); }
  }

  /** Log a per-network limit refusal without letting a refusal loop flood the log. */
  limitWarn(text) {
    const now = this.now();
    if (now - this.limitLog.at < 10_000) { this.limitLog.suppressed++; return; }
    const more = this.limitLog.suppressed ? ` (+${this.limitLog.suppressed} similar refusals)` : '';
    this.limitLog.at = now;
    this.limitLog.suppressed = 0;
    this.log.warn(`[lobby] ${text}${more}`);
  }

  /** Number of rooms matching a predicate. */
  countRooms(pred) {
    let n = 0;
    for (const r of this.rooms.values()) if (pred(r)) n++;
    return n;
  }

  /** Route a 'g.*' intent to the running match. */
  routeGame(session, msg) {
    const room = this.roomOf(session);
    if (!room) return fail(ERR.NOT_IN_ROOM);
    if (!room.match) return fail(ERR.WRONG_PHASE, 'no running match');
    if (msg.t === 'g.leave') {
      this.removeMember(room, session.playerId);
      return OK;
    }
    // a spectator only watches (header): nothing else of it ever reaches the match
    if (msg.t !== 'g.watch' && room.spectatorOf(session.playerId)) return fail(ERR.SPECTATOR);
    let res;
    try {
      res = room.match.handle(session.playerId, msg);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) threw`, e);
      return fail(ERR.INTERNAL);
    }
    if (res && typeof res.then === 'function') {
      // Contract violation (handle must be synchronous): never let the rejection go unhandled.
      this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) returned a Promise; it must be synchronous`);
      Promise.resolve(res).catch((e) => this.log.error(`[lobby] ${room.code} match.handle(${msg.t}) rejected`, e));
      return OK;
    }
    if (res && typeof res === 'object' && res.error) {
      return fail(isErrCode(res.error) ? res.error : ERR.INTERNAL, typeof res.detail === 'string' ? res.detail : undefined);
    }
    return OK;
  }

  /** Call an optional match hook without letting it throw. onLeave falls back to onDisconnect. */
  callMatch(room, method, ...args) {
    const m = room.match;
    if (!m) return undefined;
    let fn = m[method];
    if (typeof fn !== 'function' && method === 'onLeave') fn = m.onDisconnect;
    if (typeof fn !== 'function') return undefined;
    try {
      return fn.apply(m, args);
    } catch (e) {
      this.log.error(`[lobby] ${room.code} match.${method} threw`, e);
      return undefined;
    }
  }

  disposeMatchCtx(ctx) {
    if (ctx.disposed) return;
    ctx.disposed = true;
    ctx.live = false;
    try { ctx.match?.dispose?.(); } catch (e) { this.log.error('[lobby] match.dispose threw', e); }
  }

  safeData() {
    try { return this.getData(); } catch (e) { this.log.error('[lobby] getData failed', e); return Object.freeze({}); }
  }

  /** How long a dropped solo run stays resumable (ms): the option, else data singleReconnectTime, else 24 h. */
  soloResumeWindowMs() {
    const o = this.opts.soloReconnectWindowMs;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    const sec = this.safeData()?.config?.constants?.singleReconnectTime;
    return (typeof sec === 'number' && Number.isFinite(sec) && sec > 0 ? sec : SOLO_RECONNECT_FALLBACK_SEC) * 1000;
  }

  // ---------------------------------------------------------------------------------------------------
  // Membership helpers
  // ---------------------------------------------------------------------------------------------------

  /** The session's current room (self-heals stale `roomCode`). @returns {Room | null} */
  roomOf(session) {
    if (!session.roomCode) return null;
    const room = this.rooms.get(session.roomCode);
    const seat = room ? room.seatOf(session.playerId) : null;
    if (room && !seat && room.spectatorOf(session.playerId)) return room; // a spectator seat
    if (!room || !seat || seat.left || seat.isBot) { session.roomCode = null; return null; }
    return room;
  }

  /** @returns {Seat} */
  humanSeat(idx, session) {
    return {
      seat: idx, playerId: session.playerId, name: session.name, isBot: false, ready: false, connected: session.connected, left: false,
      loadout: session.loadout || null,
      notOwned: session.notOwned || null,
      diy: session.diy || null,
    };
  }

  /**
   * Remove a human from a room permanently (leave, grace timeout, expiry, switching rooms).
   * In LOBBY the seat is freed; during a match it is marked departed and match.onLeave is called.
   * @param {Room} room @param {string} playerId
   */
  removeMember(room, playerId) {
    const session = this.registry.byId(playerId);
    if (session && session.roomCode === room.code) session.roomCode = null;
    this.clearGrace(playerId);
    this.dropReplay(room, playerId);
    if (this.freeSpectatorSeat(room, playerId)) return;
    const seat = room.seatOf(playerId);
    if (!seat || seat.isBot || seat.left || room.disposed) return;
    if (room.match) {
      seat.left = true;
      seat.connected = false;
      seat.ready = false;
      this.callMatch(room, 'onLeave', playerId);
    } else {
      room.seats[seat.seat] = null;
    }
    if (room.disposed) return; // onLeave may have ended the match and emptied the room
    if (room.hostId === playerId) this.migrateHost(room);
    if (room.activeHumans().length === 0) this.disposeRoom(room, 'empty');
    else this.broadcastState(room);
  }

  /**
   * Free a spectator seat (removeMember): the match forgets the spectator; never a host change or a disposal — a
   * spectator neither holds the host nor keeps a room alive. @returns {boolean} true when it was a spectator seat
   */
  freeSpectatorSeat(room, playerId) {
    const i = room.spectators.findIndex((s) => s.playerId === playerId);
    if (i < 0) return false;
    room.spectators.splice(i, 1);
    if (room.disposed) return true;
    this.callMatch(room, 'removeSpectator', playerId);
    this.broadcastState(room);
    return true;
  }

  /** Lowest-seat connected human becomes host (else lowest-seat human, else null). */
  migrateHost(room) {
    const humans = room.activeHumans();
    const pick = humans.find((s) => s.connected) || humans[0] || null;
    const prev = room.hostId;
    room.hostId = pick ? pick.playerId : null;
    if (pick && prev !== pick.playerId) this.log.info(`[lobby] ${room.code} host → ${pick.name}`);
  }

  startGrace(room, seat) {
    const playerId = seat.playerId;
    this.clearGrace(playerId);
    const t = setTimeout(() => {
      this.graceTimers.delete(playerId);
      if (room.disposed || room.match) return;
      const s = room.seatOf(playerId) || room.spectatorOf(playerId);
      if (!s || s.connected) return;
      const session = this.registry.byId(playerId);
      if (session && session.roomCode === room.code) {
        session.notice = 'timeout';
        session.pendingResult = this.replayFor(room, playerId); // still shown after room.closed on resume
      }
      this.removeMember(room, playerId);
    }, this.opts.lobbyGraceMs);
    t.unref?.();
    this.graceTimers.set(playerId, t);
  }

  clearGrace(playerId) {
    const t = this.graceTimers.get(playerId);
    if (t) { clearTimeout(t); this.graceTimers.delete(playerId); }
  }

  /**
   * Delete a room, detach its members (room.closed unless the room simply emptied) and dispose its match.
   * @param {Room} room @param {string} reason
   */
  disposeRoom(room, reason) {
    if (room.disposed) return;
    room.disposed = true;
    if (this.rooms.get(room.code) === room) this.rooms.delete(room.code);
    const ctx = room.matchCtx;
    room.match = null;
    room.matchCtx = null;
    room.matchKey = null;
    room.replay = null;
    for (const s of room.seats) {
      if (!s || s.isBot) continue;
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (s.left || reason === 'empty') continue;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    // spectators did not leave: they are told whatever closed the room (its last human leaving included)
    for (const s of room.spectators) {
      this.clearGrace(s.playerId);
      const session = this.registry.byId(s.playerId);
      if (!session || session.roomCode !== room.code) continue;
      session.roomCode = null;
      if (session.connected) sendSession(session, { t: 'room.closed', reason });
      else session.notice = reason;
    }
    if (ctx) this.disposeMatchCtx(ctx);
    // pending quick invites to this room die with it (their sender is told, so nobody waits on a dead code)
    if (this.accounts) {
      for (const inv of this.accounts.dropInvitesForRoom(room.code)) {
        this.sendToAccount(inv.from, { t: 'invite.done', inviteId: inv.inviteId, ok: false, reason: 'room-closed' });
      }
      // the members just lost their room: their friends' view of them changes to idle
      for (const seat of [...room.seats, ...room.spectators]) {
        if (!seat || seat.isBot) continue;
        const session = this.registry.byId(seat.playerId);
        if (session && session.accountId) this.notifyFriends(session.accountId, true);
      }
    }
    this.log.info(`[lobby] ${room.code} disposed (${reason})`);
  }

  genCode() {
    for (let attempt = 0; attempt < 1000; attempt++) {
      let code = '';
      for (let i = 0; i < ROOM_CODE_LEN; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------------------------------

  /** Connected, non-departed human sessions of a room — its spectators included (room.state, match broadcasts). */
  *memberSessions(room) {
    for (const s of [...room.seats, ...room.spectators]) {
      if (!s || s.isBot || s.left) continue;
      const session = this.registry.byId(s.playerId);
      if (session && session.connected && session.roomCode === room.code) yield session;
    }
  }

  broadcastState(room) {
    if (room.disposed) return;
    const data = encode(room.toState());
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data);
    // every visible room change is also a presence change for the members' friends (status, room, occupancy);
    // notifyMembers is content-deduped and coalesced per account, so a ready toggle costs nothing on the wire
    this.notifyMembers(room);
  }

  /** Notify the friends of every signed-in member of a room (see broadcastState). */
  notifyMembers(room) {
    if (!this.accounts) return;
    for (const seat of [...room.seats, ...room.spectators]) {
      if (!seat || seat.isBot || seat.left) continue;
      const session = this.registry.byId(seat.playerId);
      if (session && session.accountId) this.notifyFriends(session.accountId);
    }
  }

  sendState(room, session) {
    sendSession(session, room.toState());
  }

  /** Match broadcast: encode once, send to every connected member. @returns {string | null} the encoded frame */
  broadcastRoom(room, msg) {
    if (room.disposed) return null;
    const data = encode(msg);
    if (data == null) { this.log.error(`[lobby] ${room.code} unserializable broadcast ${msg && msg.t}`); return null; }
    const droppable = isDroppable(msg);
    for (const session of this.memberSessions(room)) sendRaw(session.ws, data, { droppable });
    return data;
  }

  /** Match unicast. @returns {boolean} */
  sendToPlayer(room, playerId, msg) {
    if (room.disposed) return false;
    const seat = room.seatOf(playerId) || room.spectatorOf(playerId);
    if (!seat || seat.isBot || seat.left) return false;
    const session = this.registry.byId(playerId);
    if (!session || session.roomCode !== room.code) return false;
    return sendSession(session, msg);
  }
}
