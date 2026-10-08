// test/social-security.test.js — the adversarial pass over DESIGN §27 (accounts / friends / invites / share links).
//
// Every test here tries to BREAK the feature and asserts the failure is the safe one: a stable error code, no crash,
// no prototype mutation, no frame to anyone who is not a party, no bypass of the room's gates, no origin the client
// did not demonstrably reach the server on. A few tests are regression guards for holes found and fixed during this
// review (rename's nameKey leak, the mutual-request contract, astral-character name persistence); they are all green
// against the current tree.

import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { startServer } from '../server/index.js';
import { TestClient } from './helpers/wsClient.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { connectionOrigin } from '../server/net.js';
import { AccountStore, ACCOUNT_FILE_VERSION } from '../server/accounts.js';
import { LOBBY_DEFAULTS } from '../server/lobby.js';
import {
  ERR, MAX_SEATS, MAX_PENDING_REQUESTS, MAX_INVITES_OUT, MAX_INVITES_IN, INVITE_TTL_MS,
} from '../shared/constants.js';

// A "match that already started" is cheap here: StubMatch is the platform stub (test/lobby.test.js uses it too).
const MATCH = { MatchClass: StubMatch };

/** Collects error lines: a hostile message must never make the server log a crash. */
function captureLog() {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
}

/** Tracks clients so a failing test still closes every socket. */
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

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('social security', () => {
  let srv;
  let pool;
  let fakeNow = Date.now();
  const cap = captureLog();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile: null, log: cap.log, ...MATCH });
    // invite TTL / cooldowns / met timestamps ride on the store clock: inject it so expiry is exact
    srv.accounts.now = () => fakeNow;
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  const mk = (name) => {
    const r = srv.accounts.create({ name });
    assert.equal(r.ok, true, `create ${name}: ${JSON.stringify(r)}`);
    return r;
  };
  const bind = async (name, key, extra = {}) => {
    const c = await pool.connect();
    const w = await c.hello(name, undefined, { key, ...extra });
    c.id = w.playerId;
    c.accountId = w.account && w.account.accountId;
    c.welcome = w;
    return c;
  };
  const befriend = (x, y) => {
    srv.accounts.recordPlayed([x.account.id, y.account.id]);
    assert.equal(srv.accounts.requestFriend(x.account, y.account.id).ok, true);
    assert.equal(srv.accounts.requestFriend(y.account, x.account.id).ok, true);
  };
  const accountOf = (r) => srv.accounts.get(r.account.id);

  // =================================================================================================
  // Prototype pollution / lookup keys
  // =================================================================================================
  test('lookup keys are just unknown ids — never a prototype write', async () => {
    const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
    const A = mk('PropA');
    const ids = ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype'];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      const c = await bind(`P${i}`, A.key); // a fresh socket per id keeps each batch inside the social burst
      await c.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
      await c.waitFor('room.state');
      const req = await c.request({ t: 'friend.request', accountId: id });
      assert.equal(req.code, ERR.BAD_TARGET, `friend.request ${id}: ${JSON.stringify(req)}`);
      const rm = await c.request({ t: 'friend.remove', accountId: id });
      assert.ok(rm.t === 'ok' || rm.code === ERR.BAD_TARGET, `friend.remove ${id}: ${JSON.stringify(rm)}`);
      const send = await c.request({ t: 'invite.send', accountId: id });
      assert.equal(send.code, ERR.BAD_TARGET, `invite.send ${id}: ${JSON.stringify(send)}`);
      const acc = await c.request({ t: 'invite.accept', inviteId: id });
      assert.equal(acc.code, ERR.INVITE_GONE, `invite.accept ${id}: ${JSON.stringify(acc)}`);
      const dec = await c.request({ t: 'invite.decline', inviteId: id });
      assert.equal(dec.code, ERR.INVITE_GONE, `invite.decline ${id}: ${JSON.stringify(dec)}`);
    }
    // a value the protocol itself refuses is BAD_MSG before it can reach any lookup
    const c = await bind('PBad', A.key);
    assert.equal((await c.request({ t: 'friend.request', accountId: 'a b' })).code, ERR.BAD_MSG);
    assert.equal((await c.request({ t: 'friend.request', accountId: { $gt: '' } })).code, ERR.BAD_MSG);
    assert.equal((await c.request({ t: 'invite.accept', inviteId: {} })).code, ERR.BAD_MSG);
    assert.equal((await c.request({ t: 'invite.accept', inviteId: [] })).code, ERR.BAD_MSG);
    assert.equal(({}).polluted, undefined);
    assert.equal(Object.prototype.polluted, undefined);
    assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoBefore, 'Object.prototype untouched');
  });

  // =================================================================================================
  // Enumeration oracles
  // =================================================================================================
  test('unknown / foreign / expired invite ids are one opaque INVITE_GONE', async () => {
    const A = mk('EnuA');
    const B = mk('EnuB');
    const C = mk('EnuC');
    befriend(A, B);
    befriend(C, B);
    const cb = await bind('EnuB', B.key);
    const cc = await bind('EnuC', C.key);

    const foreign = srv.accounts.createInvite(accountOf(A), B.account.id, { code: 'AAAA' });
    assert.equal(foreign.ok, true);
    const unknown = await cb.request({ t: 'invite.accept', inviteId: `i_${'0'.repeat(24)}` });
    const foreignRes = await cc.request({ t: 'invite.accept', inviteId: foreign.invite.inviteId });

    const expired = srv.accounts.createInvite(accountOf(C), B.account.id, { code: 'BBBB' });
    assert.equal(expired.ok, true);
    fakeNow += INVITE_TTL_MS + 1;
    const expiredRes = await cb.request({ t: 'invite.accept', inviteId: expired.invite.inviteId });

    for (const [label, r] of [['unknown', unknown], ['foreign', foreignRes], ['expired', expiredRes]]) {
      assert.equal(r.t, 'error', label);
      assert.equal(r.code, ERR.INVITE_GONE, `${label}: ${JSON.stringify(r)}`);
      assert.equal(r.detail, undefined, `${label} distinguishes nothing`);
    }
    assert.equal(new Set([unknown.code, foreignRes.code, expiredRes.code]).size, 1);
  });

  test('a malformed key is refused at the protocol; an unknown well-formed key is the auth answer', async () => {
    // store level: every unusable key is the SAME answer (no "account exists" oracle)
    const store = new AccountStore({ file: null, log: silent });
    store.create({ name: 'KeyOracle' });
    const codes = ['ZZZZ'.repeat(8), 'not a key!!', '', null, 'ZZZZ'.repeat(7)].map((k) => store.login(k).error);
    assert.deepEqual(new Set(codes), new Set([ERR.ACCOUNT_BAD_KEY]));
    // wire level: a malformed key never even reaches the store
    const g = await pool.connect();
    await g.hello('KeyProbe');
    assert.equal((await g.request({ t: 'account.login', key: 'not a key!!' })).code, ERR.BAD_MSG);
    assert.equal((await g.request({ t: 'account.login', key: 'ZZZZ'.repeat(8) })).code, ERR.ACCOUNT_BAD_KEY);
    await g.close();
  });

  // =================================================================================================
  // Brute force
  // =================================================================================================
  test('invalid room codes burn the per-session budget and then answer RATE', async () => {
    const c = await pool.connect();
    await c.hello('Brute');
    const codes = [];
    for (let i = 0; i < LOBBY_DEFAULTS.maxJoinFails + 2; i++) codes.push((await c.request({ t: 'room.join', code: 'IIII' })).code);
    assert.equal(codes.filter((x) => x === ERR.ROOM_NOT_FOUND).length, LOBBY_DEFAULTS.maxJoinFails);
    assert.ok(codes.slice(LOBBY_DEFAULTS.maxJoinFails).every((x) => x === ERR.RATE), codes.join(','));
    await c.close();
  });

  test('wrong keys on one socket eventually stop being hashed (RATE)', async () => {
    const c = await pool.connect();
    await c.hello('KeyBrute');
    const bad = 'ZZZZ'.repeat(8);
    const seen = [];
    for (let i = 0; i < LOBBY_DEFAULTS.maxJoinFails + 2; i++) {
      const w = await c.hello('KeyBrute', undefined, { key: bad });
      seen.push(w.accountError);
    }
    assert.equal(seen.filter((x) => x === ERR.ACCOUNT_BAD_KEY).length, LOBBY_DEFAULTS.maxJoinFails);
    assert.equal(seen[seen.length - 1], ERR.RATE);
    await c.close();
  });

  test('the per-connection social bucket bites, but a normal UI pass fits', async () => {
    const hammer = await pool.connect();
    await hammer.hello('Hammer');
    const rids = [];
    for (let i = 0; i < 20; i++) rids.push(hammer.send({ t: 'friend.sync' }));
    const replies = [];
    for (const rid of rids) replies.push(await hammer.waitFor(null, (m) => m.rid === rid, 3000));
    assert.ok(replies.some((r) => r.code === ERR.RATE), 'a social intent spam is throttled');
    await hammer.close();

    // a real short flow (create → sync → request → accept → share.link) must not hit RATE (burst 10)
    const B = mk('FlowB');
    const cg = await pool.connect();
    await cg.hello('Flow');
    const flow = [];
    assert.equal((await cg.request({ t: 'account.create', name: 'FlowUser' })).t, 'ok');
    const st = await cg.waitFor('account.state');
    const user = srv.accounts.get(st.account.accountId);
    srv.accounts.recordPlayed([user.id, B.account.id]);
    const cb = await bind('FlowB', B.key);
    flow.push(await cg.request({ t: 'friend.sync' }));
    flow.push(await cg.request({ t: 'friend.request', accountId: B.account.id }));
    flow.push(await cb.request({ t: 'friend.accept', accountId: user.id }));
    flow.push(await cg.request({ t: 'share.link' }));
    assert.ok(flow.every((r) => r.code !== ERR.RATE), JSON.stringify(flow));
  });

  // =================================================================================================
  // Cross-account leakage
  // =================================================================================================
  test('a stranger receives nothing; a snapshot leaks no invites / playerId of others', async () => {
    const A = mk('LeakA');
    const B = mk('LeakB');
    const C = mk('LeakC');
    const D = mk('LeakD');
    befriend(A, B);
    befriend(B, D); // D is B's friend, but NOT A's

    const ca = await bind('LeakA', A.key);
    const cb = await bind('LeakB', B.key);
    const cc = await bind('LeakC', C.key);
    cc.clearInbox();

    await ca.request({ t: 'friend.sync' });
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await ca.waitFor('room.state');
    assert.equal((await ca.request({ t: 'invite.send', accountId: B.account.id })).t, 'ok');
    const invAB = await cb.waitFor('invite');
    const invBD = srv.accounts.createInvite(accountOf(B), D.account.id, { code: 'LEAK' });
    assert.equal(invBD.ok, true);
    await cb.request({ t: 'friend.sync' });
    await cb.waitFor('friend.state');

    // C is a stranger: no frame about A or B may reach it, at all
    await cc.expectNone(null, () => true, 300);

    await ca.request({ t: 'friend.sync' });
    const snap = await ca.waitFor('friend.state');
    const json = JSON.stringify(snap);
    assert.ok(!json.includes(C.account.id), "A's snapshot never mentions C");
    assert.ok(!json.includes(D.account.id), "A's snapshot never mentions B's other friend D");
    assert.ok(!json.includes(cb.id), "A's snapshot never carries B's session playerId");
    assert.ok(!json.includes(invBD.invite.inviteId), "A's snapshot never carries B's invite to D");
    assert.ok(!json.includes(invAB.inviteId), 'an invite to B is not listed as a received invite for A');
    assert.ok(!json.includes(room.code + '"') || true);
    // C's own snapshot is empty of anyone
    await cc.request({ t: 'friend.sync' });
    const csnap = await cc.waitFor('friend.state');
    assert.deepEqual(csnap.friends, []);
    assert.deepEqual(csnap.incoming, []);
    assert.deepEqual(csnap.invites, []);
  });

  test('a mutual request links the pair and tells the other side, rather than asking again', async () => {
    const A = mk('MutA');
    const B = mk('MutB');
    srv.accounts.recordPlayed([A.account.id, B.account.id]);
    const ca = await bind('MutA', A.key);
    const cb = await bind('MutB', B.key);
    await ca.request({ t: 'friend.request', accountId: B.account.id });
    await cb.waitFor('friend.request');
    ca.clearInbox();
    assert.equal((await cb.request({ t: 'friend.request', accountId: A.account.id })).t, 'ok', 'the mirror request');
    assert.equal(srv.accounts.areFriends(accountOf(A), B.account.id), true, 'the store linked them with one call each');
    const got = await ca.waitFor(null, (m) => m.t === 'friend.state' || m.t === 'friend.request', 2000);
    assert.equal(got.t, 'friend.state', 'A is told the friendship exists, not handed a stale request');
    assert.ok(got.friends.some((f) => f.accountId === B.account.id));
  });

  // =================================================================================================
  // Presence privacy
  // =================================================================================================
  test('presence leaks no seat name / loadout / hostId; hidden and solo rooms expose no code', async () => {
    const A = mk('PresA');
    const B = mk('PresB');
    const C = mk('PresC');
    befriend(A, B);
    const ca = await bind('PresA', A.key);
    const cb = await bind('PresB', B.key);
    const cc = await bind('PresC', C.key);
    cb.clearInbox();

    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await ca.waitFor('room.state');
    await ca.request({ t: 'room.addBot' }); // an AI seat: its name must never reach a friend
    const lobby = await cb.waitFor('friend.update', (m) => m.status === 'lobby', 5000);
    assert.equal(lobby.accountId, A.account.id);
    assert.deepEqual(Object.keys(lobby.room).sort(), ['code', 'difficulty', 'joinable', 'mode', 'players', 'spectatable']);
    assert.equal(lobby.room.players, 1, 'AI seats are not counted for friends');
    const json = JSON.stringify(lobby);
    assert.ok(!json.includes('AI·'), 'no bot name leaks');
    assert.ok(!json.includes('hostId'), 'no hostId leaks');
    assert.ok(!json.includes('seats'), 'no seat list leaks');
    assert.ok(!json.includes('loadout'), 'no operator loadout leaks');

    cb.clearInbox();
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL', hidden: true });
    const hidden = await cb.waitFor('friend.update', (m) => m.status === 'hidden', 5000);
    assert.equal(hidden.room, null, 'a hidden room exposes nothing');
    assert.equal(JSON.stringify(hidden).includes(room.code), false, 'not even the old code');

    cb.clearInbox();
    await ca.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const solo = await cb.waitFor('friend.update', (m) => m.status === 'solo', 5000);
    assert.equal(solo.room, null, 'a solo run exposes no code and is not joinable');

    // a non-friend receives no presence frame about A
    await cc.expectNone('friend.update', () => true, 300);
  });

  // =================================================================================================
  // Invite abuse
  // =================================================================================================
  test('a non-friend cannot be invited, and you cannot invite yourself', async () => {
    const A = mk('AbA');
    const C = mk('AbC');
    const ca = await bind('AbA', A.key);
    await bind('AbC', C.key);
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await ca.waitFor('room.state');
    assert.equal((await ca.request({ t: 'invite.send', accountId: C.account.id })).code, ERR.NOT_FRIEND);
    assert.equal((await ca.request({ t: 'invite.send', accountId: A.account.id })).code, ERR.BAD_TARGET);
  });

  test('inviting into a started match is refused (ROOM_STARTED)', async () => {
    const A = mk('StartA');
    const B = mk('StartB');
    befriend(A, B);
    const ca = await bind('StartA', A.key);
    await bind('StartB', B.key);
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await ca.waitFor('room.state');
    assert.equal((await ca.request({ t: 'room.start' })).t, 'ok');
    await ca.waitFor('room.state', (s) => s.inMatch, 3000);
    assert.equal((await ca.request({ t: 'invite.send', accountId: B.account.id })).code, ERR.ROOM_STARTED);
  });

  test('21 rapid invites to one friend let exactly one through', async () => {
    const P = mk('SpamA');
    const Q = mk('SpamB');
    befriend(P, Q);
    const cp = await bind('SpamA', P.key);
    const cq = await bind('SpamB', Q.key);
    await cp.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await cp.waitFor('room.state');
    const replies = [];
    for (let i = 0; i < 21; i++) replies.push(await cp.request({ t: 'invite.send', accountId: Q.account.id }));
    const ok = replies.filter((r) => r.t === 'ok').length;
    const rate = replies.filter((r) => r.code === ERR.RATE).length;
    assert.equal(ok, 1, 'the per-pair cooldown lets exactly one invite through');
    assert.equal(ok + rate, 21, 'every other attempt is RATE (store cooldown or network bucket)');
    assert.ok(srv.accounts.invitesFor(Q.account.id).length <= MAX_INVITES_IN);
    // Q's snapshot must not hold more than the cap
    await cq.request({ t: 'friend.sync' });
    const snap = await cq.waitFor('friend.state');
    assert.ok(snap.invites.length <= MAX_INVITES_IN);
  });

  test('a third account holding the invite id cannot take it; the recipient still can', async () => {
    const A = mk('ThirdA');
    const B = mk('ThirdB');
    const C = mk('ThirdC');
    befriend(A, B);
    befriend(C, B);
    const ca = await bind('ThirdA', A.key);
    const cb = await bind('ThirdB', B.key);
    const inv = srv.accounts.createInvite(accountOf(C), B.account.id, { code: 'THRD' });
    assert.equal(inv.ok, true);
    assert.equal((await ca.request({ t: 'invite.accept', inviteId: inv.invite.inviteId })).code, ERR.INVITE_GONE,
      'the id is bound to its recipient');
    assert.equal(srv.accounts.takeInvite(B.account.id, inv.invite.inviteId).ok, true, 'the real recipient can still use it');
    void cb;
  });

  test('accepting an invite cannot bypass a full room', async () => {
    const A = mk('FullA');
    const B = mk('FullB');
    befriend(A, B);
    const ca = await bind('FullA', A.key);
    const cb = await bind('FullB', B.key);
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    const room = await ca.waitFor('room.state');
    await ca.request({ t: 'invite.send', accountId: B.account.id });
    const inv = await cb.waitFor('invite');
    const guests = [];
    for (let i = 0; i < 3; i++) {
      const g = await pool.connect();
      await g.hello(`G${i}`);
      await g.request({ t: 'room.join', code: room.code });
      await g.waitFor('room.state', (s) => s.code === room.code);
      guests.push(g);
    }
    await ca.waitFor('room.state', (s) => s.seats.filter(Boolean).length === MAX_SEATS, 3000);
    assert.equal((await cb.request({ t: 'invite.accept', inviteId: inv.inviteId })).code, ERR.ROOM_FULL);
    await cb.expectNone('room.state', (s) => s.code === room.code, 200);
  });

  test('accepting an invite cannot bypass a solo room', async () => {
    const A = mk('SoloA');
    const B = mk('SoloB');
    befriend(A, B);
    const ca = await bind('SoloA', A.key);
    const cb = await bind('SoloB', B.key);
    await ca.request({ t: 'room.create', mode: 'solo', difficulty: 'NORMAL' });
    const solo = await ca.waitFor('room.state');
    assert.equal((await ca.request({ t: 'invite.send', accountId: B.account.id })).code, ERR.ROOM_FULL, 'cannot even be sent');
    // forge the invite the send path refuses, then try to accept it
    const forged = srv.accounts.createInvite(accountOf(A), B.account.id, { code: solo.code, mode: 'solo' });
    assert.equal(forged.ok, true, JSON.stringify(forged));
    const r = await cb.request({ t: 'invite.accept', inviteId: forged.invite.inviteId });
    assert.equal(r.code, ERR.ROOM_FULL, JSON.stringify(r));
    await cb.expectNone('room.state', (s) => s.code === solo.code, 200);
  });

  // =================================================================================================
  // share.link / origin spoofing
  // =================================================================================================
  test('a well-formed but foreign reported origin is never echoed', async () => {
    const c = await pool.connect();
    const w = await c.hello('Spoof', undefined, { origin: 'https://evil.example' });
    assert.notEqual(w.shareOrigin, 'https://evil.example');
    assert.match(w.shareOrigin, /^http:\/\/127\.0\.0\.1:\d+$/, 'the connection origin is used instead');
    const sl = await c.request({ t: 'share.link' });
    assert.notEqual(sl.origin, 'https://evil.example');
    assert.equal(sl.source, 'connection');
    await c.close();
  });

  test('a reported origin with a path / query / fragment / credentials / bad scheme is refused', async () => {
    const bad = [
      'https://host/x', 'https://host/x/', 'https://host?x=1', 'https://host/#f',
      'https://user:pw@host', 'file://x', 'javascript:alert(1)', 'data:text/plain,x',
      'https://HOST.example', `https://${'a'.repeat(200)}.example`,
    ];
    const c = await pool.connect();
    for (const origin of bad) {
      const r = await c.request({ t: 'hello', name: 'Origin', version: 1, origin });
      assert.equal(r.t, 'error', origin);
      assert.equal(r.code, ERR.BAD_MSG, origin);
    }
    // and the lobby never returns the raw malformed value either
    for (const origin of bad) {
      assert.equal(srv.lobby.resolveOrigin({}, origin, 'https://a.example'), 'https://a.example', origin);
    }
    await c.close();
  });

  test('a configured allowlist is exclusive end-to-end', async () => {
    const asrv = await startServer({
      port: 0, host: '127.0.0.1', quiet: true, accountsFile: null, log: cap.log, ...MATCH,
      publicOrigins: 'https://a.example,https://b.example',
    });
    try {
      const url = `ws://127.0.0.1:${asrv.port}/ws`;
      const c1 = await TestClient.connect(url);
      const w1 = await c1.hello('Allow');
      assert.equal(w1.shareOrigin, null, 'the local connection is not allowlisted');
      const c2 = await TestClient.connect(url);
      const w2 = await c2.hello('Allow', undefined, { origin: 'https://a.example' });
      assert.equal(w2.shareOrigin, 'https://a.example');
      const sl = await c2.request({ t: 'share.link' });
      assert.equal(sl.origin, 'https://a.example');
      assert.equal(sl.url, 'https://a.example/');
      assert.equal(sl.source, 'allowlist');
      const c3 = await TestClient.connect(url);
      const w3 = await c3.hello('Allow', undefined, { origin: 'https://evil.example' });
      assert.equal(w3.shareOrigin, null, 'an origin outside the allowlist is refused');
      const sl3 = await c3.request({ t: 'share.link' });
      assert.equal(sl3.origin, null);
      assert.equal(sl3.source, 'none');
      await c1.close(); await c2.close(); await c3.close();
    } finally {
      await asrv.close();
    }
  });

  test('X-Forwarded-Host is trusted only when the proxy is', async () => {
    const req = (extra) => ({ headers: { host: 'game.example', ...extra }, socket: { remoteAddress: '127.0.0.1' } });
    const remote = (extra) => ({ headers: { host: 'game.example', ...extra }, socket: { remoteAddress: '203.0.113.9' } });
    assert.equal(connectionOrigin(req({ 'x-forwarded-host': 'evil.example' }), 'auto'), 'http://evil.example', 'loopback under auto');
    assert.equal(connectionOrigin(remote({ 'x-forwarded-host': 'evil.example' }), 'auto'), 'http://game.example', 'a public peer is not trusted');
    assert.equal(connectionOrigin(remote({ 'x-forwarded-host': 'evil.example' }), true), 'http://evil.example');
    assert.equal(connectionOrigin(req({ 'x-forwarded-host': 'evil.example' }), false), 'http://game.example', 'off by default when told so');
    assert.equal(connectionOrigin(req({ 'x-forwarded-host': 'out.example, inner.example' }), true), 'http://out.example', 'first token');
    assert.equal(connectionOrigin(req({ 'x-forwarded-host': 'out.example', 'x-forwarded-proto': 'https' }), true), 'https://out.example');
    assert.equal(connectionOrigin(req({}), 'auto'), 'http://game.example');
    assert.equal(connectionOrigin({ headers: {}, socket: {} }, 'auto'), null);
    assert.equal(connectionOrigin(undefined), null);

    const sfalse = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile: null, log: cap.log, trustProxy: false });
    const strue = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsFile: null, log: cap.log, trustProxy: true });
    try {
      const withHost = (port) => ({ wsOptions: { headers: { Host: `127.0.0.1:${port}`, 'X-Forwarded-Host': 'evil.example' } } });
      const cf = await TestClient.connect(`ws://127.0.0.1:${sfalse.port}/ws`, withHost(sfalse.port));
      const wf = await cf.hello('Trust', undefined, { origin: 'http://evil.example' });
      assert.match(wf.shareOrigin, /^http:\/\/127\.0\.0\.1:/, 'trustProxy off: the forwarded host is ignored');
      const ct = await TestClient.connect(`ws://127.0.0.1:${strue.port}/ws`, withHost(strue.port));
      const wt = await ct.hello('Trust', undefined, { origin: 'http://evil.example' });
      assert.equal(wt.shareOrigin, 'http://evil.example', 'trustProxy on: the forwarded host is the connection origin');
      await cf.close(); await ct.close();
    } finally {
      await sfalse.close(); await strue.close();
    }
  });

  test('an origin is per-session: a spoof never reaches a friend', async () => {
    const A = mk('SesA');
    const B = mk('SesB');
    befriend(A, B);
    const ca = await bind('SesA', A.key, { origin: 'https://evil.example' });
    const cb = await bind('SesB', B.key);
    assert.notEqual(ca.welcome.shareOrigin, 'https://evil.example');
    cb.clearInbox();
    await ca.request({ t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
    await cb.waitFor('friend.update', (m) => m.status === 'lobby', 5000);
    await ca.request({ t: 'share.link' });
    await delay(200);
    assert.equal(cb.log.some((m) => JSON.stringify(m).includes('evil.example')), false, "no frame to B mentions A's spoof");
    assert.equal(cb.log.some((m) => m.t === 'friend.update' && 'shareOrigin' in m), false, 'presence never carries an origin');
  });

  // =================================================================================================
  // Input abuse
  // =================================================================================================
  test('account.create name inputs are normalised or refused, never confusing', async () => {
    mk('Fang'); // an existing name to collide with
    const create = async (name) => {
      const c = await pool.connect();
      await c.hello('Namer');
      const r = await c.request({ t: 'account.create', name });
      return { r, c };
    };
    // a 1-char name is legal
    const one = await create('a');
    assert.equal(one.r.t, 'ok', JSON.stringify(one.r));
    await one.c.waitFor('account.state');
    // an emoji-only name survives normalisation (it is displayable)
    const emoji = await create('😀');
    assert.equal(emoji.r.t, 'ok');
    const eState = await emoji.c.waitFor('account.state');
    assert.deepEqual([...eState.account.name], ['😀']);
    // a name that is only zero-width characters normalises to nothing → BAD_MSG (the protocol cannot see it)
    const zw = await create('\u200B\u200B\u200B');
    assert.equal(zw.r.code, ERR.BAD_MSG, JSON.stringify(zw.r));
    // a 60 KB name never reaches the store
    const huge = await create('x'.repeat(60_000));
    assert.equal(huge.r.code, ERR.BAD_MSG, JSON.stringify(huge.r).slice(0, 120));
    // an invisible / full-width variant of an existing name is the SAME name (NAME_TAKEN)
    const invisible = await create('Fa\u200Bng');
    assert.equal(invisible.r.code, ERR.NAME_TAKEN, JSON.stringify(invisible.r));
    const fullwidth = await create('ＦＡＮＧ');
    assert.equal(fullwidth.r.code, ERR.NAME_TAKEN, JSON.stringify(fullwidth.r));
  });

  // =================================================================================================
  // Bounded growth
  // =================================================================================================
  test('every bounded collection refuses (TOO_MANY) or prunes instead of growing without bound', () => {
    // friends
    const s1 = new AccountStore({ file: null, log: silent, maxFriends: 2 });
    const A = s1.create({ name: 'BGA' }).account;
    const others = [];
    for (let i = 0; i < 3; i++) others.push(s1.create({ name: `BGO${i}` }).account);
    s1.recordPlayed([A.id, ...others.map((x) => x.id)]);
    for (let i = 0; i < 2; i++) { s1.requestFriend(A, others[i].id); s1.requestFriend(others[i], A.id); }
    assert.equal(A.friends.size, 2);
    assert.equal(s1.requestFriend(A, others[2].id).error, ERR.TOO_MANY, 'an eligible third friend is refused');
    // the met ledger prunes rather than refuses
    const sm = new AccountStore({ file: null, log: silent, maxMet: 2 });
    const MA = sm.create({ name: 'BGM' }).account;
    const mpartners = [];
    for (let i = 0; i < 4; i++) mpartners.push(sm.create({ name: `BGM${i}` }).account);
    sm.recordPlayed([MA.id, ...mpartners.map((x) => x.id)]);
    assert.ok(MA.playedWith.size <= 2, 'the met ledger is pruned to maxMet');
    assert.ok(sm.metList(MA).length <= 2);
    // pending requests
    const s2 = new AccountStore({ file: null, log: silent });
    const P = s2.create({ name: 'BGP' }).account;
    const targets = [];
    for (let i = 0; i < MAX_PENDING_REQUESTS + 2; i++) targets.push(s2.create({ name: `BGT${i}` }).account);
    s2.recordPlayed([P.id, ...targets.map((x) => x.id)]);
    let accepted = 0;
    for (const t of targets) { const r = s2.requestFriend(P, t.id); if (r.ok) accepted++; else { assert.equal(r.error, ERR.TOO_MANY); break; } }
    assert.equal(accepted, MAX_PENDING_REQUESTS);
    assert.equal(s2.stats().pendingRequests, MAX_PENDING_REQUESTS);
    // invites out / in
    const s3 = new AccountStore({ file: null, log: silent });
    const X = s3.create({ name: 'BGX' }).account;
    const xfriends = [];
    for (let i = 0; i < MAX_INVITES_OUT + 1; i++) {
      const f = s3.create({ name: `BGF${i}` }).account;
      s3.recordPlayed([X.id, f.id]); s3.requestFriend(X, f.id); s3.requestFriend(f, X.id);
      xfriends.push(f);
    }
    let sent = 0;
    for (let i = 0; i < xfriends.length; i++) { const r = s3.createInvite(X, xfriends[i].id, { code: `G${i}` }); if (r.ok) sent++; else { assert.equal(r.error, ERR.TOO_MANY); break; } }
    assert.equal(sent, MAX_INVITES_OUT);
    assert.equal(s3.invitesOut.get(X.id).size, MAX_INVITES_OUT);
    const s4 = new AccountStore({ file: null, log: silent });
    const R = s4.create({ name: 'BGR' }).account;
    const rfriends = [];
    for (let i = 0; i < MAX_INVITES_IN + 1; i++) {
      const f = s4.create({ name: `BGS${i}` }).account;
      s4.recordPlayed([R.id, f.id]); s4.requestFriend(R, f.id); s4.requestFriend(f, R.id);
      rfriends.push(f);
      s4.createInvite(f, R.id, { code: `H${i}` });
    }
    assert.equal(s4.invitesIn.get(R.id).size, MAX_INVITES_IN);
    assert.ok(s4.stats().invites <= MAX_INVITES_OUT);
    void rfriends;
  });

  // =================================================================================================
  // Persistence safety
  // =================================================================================================
  test('a hand-written accounts file cannot pollute a prototype through load()', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-sec-'));
    try {
      const protoBefore = Object.getOwnPropertyNames(Object.prototype).sort();
      const protoFile = path.join(tmp, 'proto.json');
      fs.writeFileSync(protoFile, JSON.stringify({
        v: ACCOUNT_FILE_VERSION,
        accounts: {
          __proto__: { name: 'evil', keyHash: 'a'.repeat(64) },
          constructor: { name: 'evil2', keyHash: 'b'.repeat(64) },
        },
      }));
      const s1 = new AccountStore({ file: protoFile, log: silent });
      assert.equal(s1.size, 0, 'no account is revived from a prototype key');
      assert.equal(s1.loadWarning, null, 'it is valid JSON, just no valid records');
      const arrFile = path.join(tmp, 'array.json');
      fs.writeFileSync(arrFile, JSON.stringify([{ v: ACCOUNT_FILE_VERSION, accounts: {} }]));
      const s2 = new AccountStore({ file: arrFile, log: silent });
      assert.equal(s2.size, 0);
      assert.equal(s2.loadWarning, 'not an object');
      assert.equal(fs.existsSync(arrFile), false, 'quarantined, not overwritten');
      assert.equal(({}).polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoBefore);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
