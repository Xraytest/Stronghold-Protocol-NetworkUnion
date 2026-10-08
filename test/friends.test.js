// test/friends.test.js — socket-level integration of the accounts/friends/invites wire (DESIGN §27).
//
// Boots one real server in-process with `accountsFile: null` (accounts stay in memory) and drives it through
// TestClient: hello/account binding, the friend graph, room-derived presence, quick invites, share links and the
// reconnect path. No real match is started (the platform gates that need game data are covered elsewhere); presence
// is coalesced (≤1/s per account), so the tests wait for the frame they need instead of sleeping.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { CLOSE } from '../server/net.js';
import { formatKey } from '../shared/accountKey.js';
import { ERR, MAX_SEATS } from '../shared/constants.js';

/** Collects error lines: a social intent must never make the server log a crash. */
function captureLog() {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
}

describe('accounts / friends / invites over the wire', () => {
  let srv;
  let pool;
  const cap = captureLog();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile: null, log: cap.log });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  /** Mint an account straight in the store (the wire creation path has its own test). */
  const mkAccount = (name) => {
    const r = srv.accounts.create({ name });
    assert.equal(r.ok, true, `create ${name}: ${JSON.stringify(r)}`);
    return r;
  };
  /** Connect and say hello presenting `key` (a fresh account session, no social-bucket cost). */
  const bind = async (name, key) => {
    const c = await pool.connect();
    const w = await c.hello(name, undefined, { key });
    c.id = w.playerId;
    c.token = w.token;
    c.welcome = w;
    c.accountId = w.account && w.account.accountId;
    return c;
  };
  /** Two accounts that are already friends in the store. */
  const friendPair = (nameA, nameB) => {
    const a = mkAccount(nameA);
    const b = mkAccount(nameB);
    srv.accounts.recordPlayed([a.account.id, b.account.id]);
    assert.equal(srv.accounts.requestFriend(a.account, b.account.id).ok, true);
    assert.equal(srv.accounts.requestFriend(b.account, a.account.id).ok, true);
    return { a, b, aId: a.account.id, bId: b.account.id };
  };
  const expectError = async (c, msg, code) => {
    const r = await c.request(msg);
    assert.equal(r.t, 'error', `${msg.t}: ${JSON.stringify(r)}`);
    assert.equal(r.code, code, `${msg.t}: ${JSON.stringify(r)}`);
    return r;
  };

  // -------------------------------------------------------------------------------------------------
  test('hello: no key → guest; a valid key binds the account and takes over the name', async () => {
    const guest = await pool.connect();
    const wg = await guest.hello('Guest');
    assert.equal(wg.account, null);
    assert.equal(wg.accountError, undefined);
    assert.equal(wg.name, 'Guest');

    const acc = mkAccount('Keyed');
    const bound = await bind('TitleScr', acc.key);
    assert.deepEqual(bound.welcome.account, { accountId: acc.account.id, name: 'Keyed' });
    assert.equal(bound.welcome.name, 'Keyed', 'the account name beats the title-screen nickname');
    await guest.close();
    await bound.close();
  });

  test('account.create: a 39-char key rides on account.state exactly once; a second create is ALREADY', async () => {
    const c = await pool.connect();
    c.welcome = await c.hello('Creator');
    assert.equal(c.welcome.key, undefined, 'welcome never carries a key');
    assert.equal(await c.request({ t: 'account.create', name: 'Fang' }).then((r) => r.t), 'ok');
    const st = await c.waitFor('account.state');
    assert.equal(st.account.name, 'Fang');
    assert.equal(typeof st.key, 'string');
    assert.equal(st.key.length, 39);
    assert.equal(formatKey(st.key), st.key);
    // the key material appears in exactly one frame, and a repeat hello does not resend it
    assert.equal(c.log.filter((m) => JSON.stringify(m).includes(st.key)).length, 1);
    await c.hello('Fang');
    assert.equal(c.log.filter((m) => JSON.stringify(m).includes(st.key)).length, 1, 'still exactly once');
    await expectError(c, { t: 'account.create', name: 'Other' }, ERR.ALREADY);
    await c.close();
  });

  test('account.login with a bad key answers ACCOUNT_BAD_KEY and the guest session keeps working', async () => {
    const c = await pool.connect();
    await c.hello('Switcher');
    await expectError(c, { t: 'account.login', key: 'ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ' }, ERR.ACCOUNT_BAD_KEY);
    const room = await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    assert.equal(room.t, 'ok', 'the guest identity is not dropped');
    const state = await c.waitFor('room.state');
    assert.equal(state.seats[0].name, 'Switcher');
    await c.close();
  });

  test('account.logout: this session becomes a guest and friends see it go offline', async () => {
    const { a, b, aId } = friendPair('LogA', 'LogB');
    const ca = await bind('LogA', a.key);
    const cb = await bind('LogB', b.key);
    cb.clearInbox();
    assert.equal((await ca.request({ t: 'account.logout' })).t, 'ok');
    const st = await ca.waitFor('account.state');
    assert.deepEqual(st.account, null);
    const off = await cb.waitFor('friend.update', (m) => m.accountId === aId && m.online === false, 4000);
    assert.equal(off.status, 'offline');
    await ca.close();
    await cb.close();
  });

  test('friend.request is gated on having played together, then reaches the target', async () => {
    const a = mkAccount('ReqA');
    const b = mkAccount('ReqB');
    const ca = await bind('ReqA', a.key);
    const cb = await bind('ReqB', b.key);

    await expectError(ca, { t: 'friend.request', accountId: b.account.id }, ERR.NOT_ELIGIBLE);
    assert.equal(srv.accounts.recordPlayed([a.account.id, b.account.id]), 2, 'the match ledger is the only door');

    assert.equal((await ca.request({ t: 'friend.request', accountId: b.account.id })).t, 'ok');
    const push = await cb.waitFor('friend.request');
    assert.deepEqual({ accountId: push.accountId, name: push.name }, { accountId: a.account.id, name: 'ReqA' });

    // B's snapshot lists the pending request from A
    assert.equal((await cb.request({ t: 'friend.sync' })).t, 'ok');
    const snap = await cb.waitFor('friend.state');
    assert.deepEqual(snap.incoming.map((x) => x.accountId), [a.account.id]);
    assert.equal(snap.friends.length, 0);

    // accept → both sides see each other
    assert.equal((await cb.request({ t: 'friend.accept', accountId: a.account.id })).t, 'ok');
    const aState = await ca.waitFor('friend.state', (s) => s.friends.some((f) => f.accountId === b.account.id));
    const bState = await cb.waitFor('friend.state', (s) => s.friends.some((f) => f.accountId === a.account.id));
    assert.equal(aState.friends[0].online, true);
    assert.equal(bState.friends[0].name, 'ReqA');
    await ca.close();
    await cb.close();
  });

  test('presence: a friend sees a joinable lobby room, a hidden room as status hidden', async () => {
    const { a, b } = friendPair('PresA', 'PresB');
    const ca = await bind('PresA', a.key);
    const cb = await bind('PresB', b.key);

    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await ca.waitFor('room.state');
    const lobby = await cb.waitFor('friend.update', (m) => m.status === 'lobby', 5000);
    assert.equal(lobby.accountId, a.account.id);
    assert.equal(lobby.online, true);
    assert.deepEqual(Object.keys(lobby.room).sort(), ['code', 'difficulty', 'joinable', 'mode', 'players', 'spectatable']);
    assert.equal(lobby.room.code, room.code);
    assert.equal(lobby.room.mode, 'coop');
    assert.equal(lobby.room.joinable, true);
    assert.equal(lobby.room.players, 1);

    // hidden: the code is the ability to join, so it is never leaked to friends
    cb.clearInbox();
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', hidden: true });
    const hidden = await cb.waitFor('friend.update', (m) => m.status === 'hidden', 5000);
    assert.equal(hidden.room, null);
    assert.equal(JSON.stringify(hidden).includes('"code"'), false);
    await ca.close();
    await cb.close();
  });

  test('invite.send / accept: the recipient joins the room and the sender is told', async () => {
    const { a, b } = friendPair('InvA', 'InvB');
    const ca = await bind('InvA', a.key);
    const cb = await bind('InvB', b.key);

    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'HARD' });
    const room = await ca.waitFor('room.state');
    ca.clearInbox();
    assert.equal((await ca.request({ t: 'invite.send', accountId: b.account.id })).t, 'ok');
    const inv = await cb.waitFor('invite');
    assert.equal(inv.from, a.account.id);
    assert.equal(inv.fromName, 'InvA');
    assert.equal(inv.code, room.code);
    assert.equal(inv.mode, 'coop');
    assert.equal(inv.difficulty, 'HARD');
    assert.match(inv.inviteId, /^i_[0-9a-f]{24}$/);

    assert.equal((await cb.request({ t: 'invite.accept', inviteId: inv.inviteId })).t, 'ok');
    const joined = await cb.waitFor('room.state', (s) => s.code === room.code, 3000);
    assert.equal(joined.seats.filter(Boolean).length, 2);
    const done = await ca.waitFor('invite.done', (m) => m.inviteId === inv.inviteId, 3000);
    assert.equal(done.ok, true);
    assert.equal(done.by, 'InvB');
    await ca.close();
    await cb.close();
  });

  test('invite.decline tells the sender, and a dead room is not silently joined', async () => {
    const { a, b } = friendPair('DecA', 'DecB');
    const ca = await bind('DecA', a.key);
    const cb = await bind('DecB', b.key);

    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await ca.waitFor('room.state');
    await ca.request({ t: 'invite.send', accountId: b.account.id });
    const inv = await cb.waitFor('invite');
    assert.equal((await cb.request({ t: 'invite.decline', inviteId: inv.inviteId })).t, 'ok');
    const done = await ca.waitFor('invite.done', (m) => m.inviteId === inv.inviteId, 3000);
    assert.deepEqual({ ok: done.ok, declined: done.declined }, { ok: false, declined: true });

    // a disposed room invalidates the invite; accepting it must fail, not join a ghost.
    // A different sender (a fresh pair, so no per-pair invite cooldown) points at a code that no longer exists.
    const c = mkAccount('DecC');
    srv.accounts.recordPlayed([b.account.id, c.account.id]);
    assert.equal(srv.accounts.requestFriend(c.account, b.account.id).ok, true);
    assert.equal(srv.accounts.requestFriend(b.account, c.account.id).ok, true);
    ca.clearInbox();
    await ca.request({ t: 'room.leave' });
    const deadCode = 'QQQQ';
    const dead = srv.accounts.createInvite(srv.accounts.get(c.account.id), b.account.id, { code: deadCode });
    assert.equal(dead.ok, true, JSON.stringify(dead));
    assert.equal(srv.lobby.getRoom(deadCode), null, 'the code really is dead');
    await expectError(cb, { t: 'invite.accept', inviteId: dead.invite.inviteId }, ERR.ROOM_NOT_FOUND);
    await cb.expectNone('room.state', (s) => s.code === deadCode, 200);
    await ca.close();
    await cb.close();
  });

  test('friend.remove: both sides lose each other, with a push and a fresh snapshot', async () => {
    const { a, b } = friendPair('RemA', 'RemB');
    const ca = await bind('RemA', a.key);
    const cb = await bind('RemB', b.key);

    assert.equal((await ca.request({ t: 'friend.remove', accountId: b.account.id })).t, 'ok');
    const rm = await cb.waitFor('friend.remove');
    assert.equal(rm.accountId, a.account.id);
    const bState = await cb.waitFor('friend.state', (s) => s.friends.length === 0);
    const aState = await ca.waitFor('friend.state', (s) => s.friends.length === 0);
    assert.deepEqual(bState.friends, []);
    assert.deepEqual(aState.friends, []);
    await ca.close();
    await cb.close();
  });

  test('share.link answers the connection origin and the current room code', async () => {
    const acc = mkAccount('Share');
    const c = await bind('Share', acc.key);
    const noRoom = await c.request({ t: 'share.link' });
    assert.equal(noRoom.t, 'ok');
    assert.equal(noRoom.source, 'connection');
    assert.match(noRoom.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(noRoom.url, `${noRoom.origin}/`);
    assert.equal(noRoom.code, null);
    assert.equal(noRoom.origin, c.welcome.shareOrigin, 'per-connection, never broadcast');

    await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await c.waitFor('room.state');
    const withRoom = await c.request({ t: 'share.link' });
    assert.equal(withRoom.code, room.code);
    assert.equal(withRoom.origin, noRoom.origin);
    assert.equal(withRoom.url, `${withRoom.origin}/?room=${room.code}`);
    await c.close();
  });

  test('a dropped client resumes with its token and keeps its account without a key', async () => {
    const c = await pool.connect();
    const w = await c.hello('Guest');
    assert.equal((await c.request({ t: 'account.create', name: 'Resumer' })).t, 'ok');
    const st = await c.waitFor('account.state');
    const accountId = st.account.accountId;
    const token = w.token;
    await c.terminate();

    const back = await pool.connect();
    const w2 = await back.hello('Guest', token);
    assert.equal(w2.resumed, true);
    assert.equal(w2.token, token);
    assert.equal(w2.account.accountId, accountId, 'the account survives the resume with no key presented');
    assert.equal(w2.accountError, undefined);
    // presenting the key again restores the authoritative account name even after a nickname drift
    const withKey = await pool.connect();
    const w3 = await withKey.hello('Nickname', token, { key: st.key });
    assert.equal(w3.account.accountId, accountId);
    assert.equal(w3.name, 'Resumer');
    await back.close();
    await withKey.close();
  });

  test('account.rotate: the old key dies, other live sessions are dropped with 4004', async () => {
    const acc = mkAccount('Rotator');
    const ca = await bind('Rotator', acc.key);
    const cb = await bind('Rotator', acc.key); // a second live session of the same account
    assert.equal(cb.accountId, acc.account.id);
    assert.equal((await ca.request({ t: 'account.rotate' })).t, 'ok');
    const st = await ca.waitFor('account.state');
    assert.equal(st.account.accountId, acc.account.id);
    assert.equal(typeof st.key, 'string');
    assert.notEqual(st.key, acc.key);
    const info = await cb.closed;
    assert.equal(info.code, CLOSE.ROTATED, 'the stolen/other socket is closed');
    await ca.close();

    const fresh = await pool.connect();
    const bad = await fresh.hello('Rotator', undefined, { key: acc.key });
    assert.equal(bad.account, null);
    assert.equal(bad.accountError, ERR.ACCOUNT_BAD_KEY, 'the rotated-away key no longer logs in');
    const good = await pool.connect();
    const okWelcome = await good.hello('Rotator', undefined, { key: st.key });
    assert.equal(okWelcome.account.accountId, acc.account.id);
    await fresh.close();
    await good.close();
  });

  test('room.state still exposes all four seats and no account secret', async () => {
    const acc = mkAccount('Seats');
    const c = await bind('Seats', acc.key);
    await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await c.waitFor('room.state');
    assert.equal(room.seats.length, MAX_SEATS);
    assert.equal(room.seats[0].accountId, undefined, 'room frames key on playerId, never account id');
    assert.equal(JSON.stringify(room).includes(acc.key), false);
    await c.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// Harness (mirrors test/lobby.test.js)
// ---------------------------------------------------------------------------------------------------

/** Tracks clients per test so they are always closed. */
function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect(opts) {
      const c = await TestClient.connect(getUrl(), opts);
      open.add(c);
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
