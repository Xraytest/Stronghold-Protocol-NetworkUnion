// public/js/account.js — accounts, friends and quick invites on the client (DESIGN §27).
//
// The server side of this lives in server/accounts.js (the rules) and server/lobby.js (the wire + rooms). What this
// module owns:
//
//   * the LOCAL KEY CACHE. The account key is the login credential, so the browser keeps it (localStorage
//     `sp.account`) — a reload stays logged in without typing anything. The same key is shown to the player once on
//     creation (ui/friends.js KeyDialog) because it is also the only way to log in from another device: nothing on the
//     server can recover it, and `account.rotate` is the button for "it leaked". `net.js` reads it through
//     `accountKey()` on every `hello` (main.js wires that), so a reconnect keeps the login.
//   * the store slice `account` (see store.js emptySocial): who we are, friends + their presence, pending requests,
//     the met list (the ONLY people one may add), invites, and the share-link origin the server vouched for.
//   * the request wrappers the UI calls (create / login / rename / rotate / logout / add / accept / decline / remove /
//     invite / accept / decline / share link), all of which are thin `net.request`s that let a NetError bubble up.
//   * the push handlers: `welcome.account` (or `welcome.accountError`), `account.state`, `friend.*`, `invite`,
//     `invite.done`, and the 4004 close that means the key died elsewhere.
//
// Guests are first-class: an account is only needed to have friends. Everything room-related keeps working without one.

import { canonicalKey, formatKey, KEY_MAX_LEN, normalizeName } from '../../shared/accountKey.js';
import { ERR } from '../../shared/constants.js';
import { t } from '../../shared/i18n.js';
import { identity, NetError } from './net.js';
import { emptySocial } from './store.js';
import { toast } from './ui/toasts.js';

/** localStorage slot of the cached account key. */
export const K_ACCOUNT = 'sp.account';

/** How long an account intent waits for its hello to be accepted before it reports OFFLINE. */
const ONLINE_WAIT_MS = 8000;

/** Parse the cached account record; null when absent/corrupt. */
export function loadStored(deps = {}) {
  const storage = deps.storage !== undefined ? deps.storage : safeLocal();
  if (!storage) return null;
  let raw;
  try { raw = storage.getItem(K_ACCOUNT); } catch { return null; }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const key = canonicalKey(v.key);
    if (!key) return null;
    return {
      key,
      accountId: typeof v.accountId === 'string' && v.accountId ? v.accountId : null,
      name: typeof v.name === 'string' && v.name ? v.name : null,
    };
  } catch {
    return null;
  }
}

function safeLocal() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__sp_acc_probe__';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/** Persist the account record ({key, accountId, name}); null clears it. */
export function saveStored(rec, deps = {}) {
  const storage = deps.storage !== undefined ? deps.storage : safeLocal();
  if (!storage) return;
  try {
    if (!rec || !rec.key) storage.removeItem(K_ACCOUNT);
    else storage.setItem(K_ACCOUNT, JSON.stringify({ key: canonicalKey(rec.key), accountId: rec.accountId || null, name: rec.name || null }));
  } catch { /* quota / privacy mode: the tab simply forgets the key on reload */ }
}

/**
 * The account layer singleton. `install({net, store})` wires it to the connection and the app store; the API below is
 * what screens call.
 */
class Account {
  constructor() {
    /** @type {any} the Net singleton (set by install) */
    this.net = null;
    /** @type {any} the app store (set by install) */
    this.store = null;
    /** @type {ReturnType<typeof loadStored>} the cached credential, kept in memory too */
    this.stored = null;
    /** @type {string|null} the origin the server vouched for (welcome.shareOrigin), if any */
    this.shareOrigin = null;
    this._installed = false;
    /** @type {(() => void)[]} unsubscribe callbacks */
    this._off = [];
  }

  // ---- wiring ------------------------------------------------------------------------------------

  /**
   * Subscribe to the connection's pushes and load the cached key. Idempotent.
   * @param {{ net: any, store: any }} deps
   */
  install({ net, store }) {
    if (this._installed) return this;
    this._installed = true;
    this.net = net;
    this.store = store;
    this.stored = loadStored();
    if (this.stored) {
      store.patch('account', { accountId: this.stored.accountId, name: this.stored.name, hasKey: true });
    }
    const on = (type, fn) => { try { this._off.push(net.on(type, fn)); } catch { /* ignore */ } };
    on('welcome', (msg) => this._onWelcome(msg));
    on('account.state', (msg) => this._onAccountState(msg));
    on('friend.state', (msg) => this._onFriendState(msg));
    on('friend.request', (msg) => this._onFriendRequest(msg));
    on('friend.update', (msg) => this._onFriendUpdate(msg));
    on('friend.remove', (msg) => this._onFriendRemove(msg));
    on('invite', (msg) => this._onInvite(msg));
    on('invite.done', (msg) => this._onInviteDone(msg));
    on('rotated', () => this._onRotated());
    return this;
  }

  /** Stop listening (tests / hot reload). */
  uninstall() {
    for (const off of this._off) { try { off(); } catch { /* ignore */ } }
    this._off = [];
    this._installed = false;
  }

  // ---- state -------------------------------------------------------------------------------------

  /** @returns {any} the store's account slice */
  state() { return this.store ? this.store.get().account : emptySocial(); }

  /** @returns {boolean} whether this browser holds an account key */
  isLoggedIn() { return !!this.state().accountId; }

  /** The credential `net.js` sends in `hello` (null = guest). */
  accountKey() {
    const key = this.stored && this.stored.key;
    return typeof key === 'string' && key.length > 0 && key.length <= KEY_MAX_LEN ? key : null;
  }

  /**
   * The canonical share-link origin for this browser: the server's answer when it had an opinion, else the page's own
   * origin — which is always the correct address for the player holding this page (DESIGN §27.1).
   * @returns {string} '' in a non-browser environment
   */
  origin() {
    if (this.shareOrigin) return this.shareOrigin;
    try {
      const o = globalThis.location && globalThis.location.origin;
      return typeof o === 'string' ? o : '';
    } catch {
      return '';
    }
  }

  /** The invite link of a room code, built from this browser's own origin. @param {string} code */
  inviteLink(code) {
    const origin = this.origin();
    if (!origin || !code) return '';
    // the same shape as screens/room.js inviteLink: the page this tab is on, plus ?room=CODE
    try {
      const loc = globalThis.location;
      if (loc && typeof loc.pathname === 'string' && loc.origin === origin) return `${loc.origin}${loc.pathname}?room=${encodeURIComponent(code)}`;
    } catch { /* fall through to the origin-only form */ }
    return `${origin}/?room=${encodeURIComponent(code)}`;
  }

  // ---- session ----------------------------------------------------------------------------------

  /**
   * Guarantee a live server session before an account intent. A fresh tab opens its socket WITHOUT a hello — the
   * call-sign only goes out when the player enters the shell — so the first account action taken on the title screen
   * must say hello itself: `net.request` refuses anything else with OFFLINE. `net.setName()` is the hello path
   * (`net.request('hello')` is deliberately rejected) and it does not enter the game shell; the server accepts a
   * repeated hello on a live socket, so calling this again with the player's final call-sign is harmless.
   *
   * The call-sign is only a placeholder when nothing is typed yet (logging in with a key needs a hello before the
   * account's own name is known): the server puts the account's name on the session as soon as the key is bound, so
   * the placeholder is never visible anywhere. Without ANY name the server refuses the hello, hence the generic one.
   * @param {string} [name] the call-sign to say hello with (create passes the account name it is creating)
   * @returns {Promise<true>}
   */
  async online(name) {
    if (this.net.status === 'online') return true;
    const wanted = normalizeName(name) || normalizeName(this.state().name) || normalizeName(this.stored?.name)
      || normalizeName(identity.loadName()) || t('博士');
    const ready = new Promise((resolve, reject) => {
      let timer = null;
      const offs = [];
      // one settle path: unsubscribe everything, drop the deadline, then resolve/reject
      const settle = (fn) => {
        for (const off of offs) { try { off(); } catch { /* ignore */ } }
        if (timer != null) clearTimeout(timer);
        timer = null;
        fn();
      };
      timer = setTimeout(() => settle(() => reject(new NetError('OFFLINE'))), ONLINE_WAIT_MS);
      offs.push(this.net.on('status', (snap) => {
        if (snap && snap.status === 'online') settle(() => resolve(true));
        else if (snap && snap.status === 'closed') settle(() => reject(new NetError('CLOSED')));
      }));
      // A refused hello (a version mismatch after a deploy, a full server) must fail with ITS reason, not 8 s later
      offs.push(this.net.on('helloError', (err) => settle(() => reject(err instanceof Error ? err : new NetError('OFFLINE')))));
    });
    this.net.setName(wanted);
    return ready;
  }

  // ---- requests ----------------------------------------------------------------------------------

  /** Create an account and bind it to this session. The server answers with `account.state {key}`. */
  async create(name) {
    const clean = normalizeName(name);
    await this.online(clean);
    await this.net.request('account.create', { name: clean });
    return this.state();
  }

  /**
   * Log in with a key (from another device, or after a rotation). The key is canonicalised locally first, so a
   * mistyped / foreign-alphabet key is refused without bothering the server (shared/accountKey.js).
   * @param {string} rawKey @param {string} [name] the title screen's call-sign, used when this tab has not said hello yet
   * @returns {Promise<any>}
   */
  async login(rawKey, name) {
    const key = canonicalKey(rawKey);
    if (!key) {
      toast(t('密钥格式不正确，请检查后重试'), 'warn');
      throw new Error('BAD_KEY_FORMAT');
    }
    await this.online(name);
    await this.net.request('account.login', { key });
    // the session is bound now; remember the key so a reload stays logged in
    this.stored = { key, accountId: this.state().accountId, name: this.state().name };
    saveStored(this.stored);
    this.store.patch('account', { hasKey: true });
    return this.state();
  }

  /** Rename the account (the visible name everywhere: seat, friends, invites). */
  async rename(name) {
    const clean = normalizeName(name);
    await this.online();
    await this.net.request('account.rename', { name: clean });
    if (this.stored) saveStored({ ...this.stored, name: clean });
    return clean;
  }

  /** Mint a new key and kick every other session of this account. Resolves with the new key. */
  async rotate() {
    await this.online();
    await this.net.request('account.rotate');
    return this.state().keyFresh;
  }

  /** Stop using the account in this session (the key stays valid elsewhere). */
  async logout() {
    if (!this.state().accountId) return;
    await this.online();
    await this.net.request('account.logout');
    this.stored = null;
    saveStored(null);
    this.store.patch('account', { hasKey: false });
  }

  /** Re-fetch the whole social snapshot. */
  async sync() {
    if (!this.state().accountId) return;
    await this.online();
    await this.net.request('friend.sync');
  }

  /** Ask a played-together partner to become a friend (NOT_ELIGIBLE otherwise). */
  async addFriend(accountId) { await this.online(); await this.net.request('friend.request', { accountId }); }
  async acceptFriend(accountId) { await this.online(); await this.net.request('friend.accept', { accountId }); }
  async declineFriend(accountId) { await this.online(); await this.net.request('friend.decline', { accountId }); }
  async removeFriend(accountId) { await this.online(); await this.net.request('friend.remove', { accountId }); }
  async sendInvite(accountId) { await this.online(); await this.net.request('invite.send', { accountId }); }
  async acceptInvite(inviteId) { await this.online(); await this.net.request('invite.accept', { inviteId }); }
  async declineInvite(inviteId) { await this.online(); await this.net.request('invite.decline', { inviteId }); }

  /**
   * Ask the server for the canonical link of the room this session is in, falling back to this page's own origin.
   * @param {string|null} code the room code (the store's room) — used by the fallback
   * @returns {Promise<{ origin: string, url: string, source: string }>}
   */
  async shareLink(code) {
    const fallback = () => ({ origin: this.origin(), url: this.inviteLink(code), source: 'client' });
    try {
      const res = await this.net.request('share.link');
      if (res && typeof res.url === 'string' && res.url) {
        this.shareOrigin = typeof res.origin === 'string' && res.origin ? res.origin : this.shareOrigin;
        return { origin: res.origin || this.origin(), url: res.url, source: res.source || 'server' };
      }
    } catch { /* no server opinion: this page's own address is the right one */ }
    return fallback();
  }

  // ---- UI helpers --------------------------------------------------------------------------------

  /** Open / close the friends panel. @param {boolean} open */
  setPanel(open) { this.store.patch('ui', { friendsOpen: !!open }); }
  /** Open / close the key dialog (creation, reveal, rotation). @param {boolean} open */
  setKeyDialog(open) { this.store.patch('ui', { keyOpen: !!open }); }
  /** Forget the current "fresh key" (the dialog's close button). */
  clearFreshKey() { this.store.patch('account', { keyFresh: null }); }

  /** The key to show in the dialog: the fresh one (create/rotate) or the cached one. */
  revealKey() {
    const fresh = this.state().keyFresh;
    if (fresh) return fresh;
    return this.stored ? this.stored.key : null;
  }

  // ---- push handlers -----------------------------------------------------------------------------

  _onWelcome(msg) {
    this.shareOrigin = typeof msg.shareOrigin === 'string' && msg.shareOrigin ? msg.shareOrigin : null;
    const account = msg.account && typeof msg.account === 'object' ? msg.account : null;
    const err = typeof msg.accountError === 'string' ? msg.accountError : null;
    if (account) {
      this.store.patch('account', { accountId: account.accountId, name: account.name, error: null, hasKey: !!this.accountKey(), shareOrigin: this.shareOrigin });
      if (this.stored) saveStored({ ...this.stored, accountId: account.accountId, name: account.name });
      // one snapshot per page load: the badge counts and the panel need it, and it costs one social token
      this.sync().catch(() => {});
      return;
    }
    if (err && (err === ERR.ACCOUNT_BAD_KEY || err === ERR.RATE)) {
      // the cached key does not work any more (rotated elsewhere, or the file was reset): drop it and say so
      this.stored = null;
      saveStored(null);
      this.store.patch('account', { accountId: null, name: null, hasKey: false, error: err, ...emptySocial() });
      toast(err === ERR.RATE ? t('账号验证过于频繁，请稍后再试') : t('账号密钥已失效，请重新输入'), 'warn', { ttl: 6000 });
    }
  }

  _onAccountState(msg) {
    const account = msg.account && typeof msg.account === 'object' ? msg.account : null;
    if (!account) {
      // logged out (or the account was deleted server-side): keep whatever nickname the session has
      this.store.patch('account', { accountId: null, name: null, ...emptySocial() });
      return;
    }
    this.store.patch('account', { accountId: account.accountId, name: account.name, error: null, hasKey: !!this.accountKey() });
    // the account name is the session name on the server (server/lobby.js bindAccount): keep the UI in step
    this.store.set((s) => ({ me: { ...s.me, name: account.name } }));
    try { identity.saveName(account.name); } catch { /* ignore */ }
    if (typeof msg.key === 'string' && msg.key) {
      // the key arrives exactly once, on create and on rotate: cache it (this browser's login) and show it
      this.stored = { key: msg.key, accountId: account.accountId, name: account.name };
      saveStored(this.stored);
      this.store.patch('account', { keyFresh: msg.key, hasKey: true });
      this.setKeyDialog(true);
    }
  }

  _onFriendState(msg) {
    const list = (v) => (Array.isArray(v) ? v : []);
    this.store.patch('account', {
      friends: list(msg.friends), incoming: list(msg.incoming), outgoing: list(msg.outgoing),
      met: list(msg.met), invites: list(msg.invites), synced: true,
    });
  }

  _onFriendRequest(msg) {
    if (!msg || typeof msg.accountId !== 'string') return;
    const cur = this.state().incoming;
    if (cur.some((r) => r && r.accountId === msg.accountId)) return;
    this.store.patch('account', { incoming: [...cur, { accountId: msg.accountId, name: msg.name, at: msg.at }] });
    toast(t('{name} 想加你为好友（你们一起完成过作战）', { name: msg.name || '?' }), 'info', { ttl: 8000 });
  }

  _onFriendUpdate(msg) {
    if (!msg || typeof msg.accountId !== 'string') return;
    const friends = this.state().friends;
    const i = friends.findIndex((f) => f && f.accountId === msg.accountId);
    if (i < 0) {
      // a new friendship (or a push that beat the snapshot): refresh the snapshot once
      this.sync().catch(() => {});
      return;
    }
    const next = friends.slice();
    next[i] = { ...next[i], ...msg };
    this.store.patch('account', { friends: next });
  }

  _onFriendRemove(msg) {
    if (!msg || typeof msg.accountId !== 'string') return;
    this.store.patch('account', { friends: this.state().friends.filter((f) => f && f.accountId !== msg.accountId) });
    toast(t('{name} 已将你从好友中移除', { name: msg.name || '?' }), 'warn');
  }

  _onInvite(msg) {
    if (!msg || typeof msg.inviteId !== 'string') return;
    const cur = this.state().invites.filter((i) => i && i.inviteId !== msg.inviteId && i.code !== msg.code);
    // newest first: the popup shows invites[0]
    this.store.patch('account', { invites: [msg, ...cur].slice(0, 10) });
  }

  _onInviteDone(msg) {
    if (!msg || typeof msg !== 'object') return;
    const name = typeof msg.by === 'string' && msg.by ? msg.by : null;
    if (msg.ok) toast(name ? t('{name} 接受了你的邀请', { name }) : t('对方接受了你的邀请'), 'success');
    else if (msg.declined) toast(t('对方拒绝了你的邀请'), 'info');
    else if (msg.reason === 'room-closed') toast(t('邀请已失效：同盟已关闭'), 'warn');
    else if (msg.reason) toast(t('对方未能加入：{reason}', { reason: msg.reason }), 'warn');
  }

  _onRotated() {
    this.stored = null;
    saveStored(null);
    this.store.patch('account', { accountId: null, name: null, hasKey: false, keyFresh: null, ...emptySocial() });
    toast(t('账号密钥已在其他页面更换，本页已断开。请用新密钥登录。'), 'warn', { ttl: 9000 });
  }
}

/** The account singleton. @type {Account} */
export const account = new Account();

/** The key provider for `net.js` (main.js: `net.getKey = () => accountKey()`). */
export function accountKey() { return account.accountKey(); }

/** Human-readable "your key" text (grouped in 4s), for the copy button. @param {string} key */
export function displayKey(key) { return formatKey(key) || String(key || ''); }
