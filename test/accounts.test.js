// test/accounts.test.js — unit tests for the AccountStore (DESIGN §27): the key format, the "played together"
// ledger, the friend graph, quick invites and the defensive persistence round trip.
//
// No network and no repository writes: every store is `{ file: null }` except the persistence cases, which use a
// fresh mkdtemp directory under os.tmpdir(). The clock is always injected so invite/maintenance windows are exact.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountStore, ACCOUNT_FILE_VERSION, MAX_ACCOUNT_FILE_BYTES, DECLINE_COOLDOWN_MS } from '../server/accounts.js';
import { canonicalKey, formatKey, nameKey, normalizeName } from '../shared/accountKey.js';
import {
  ERR, MAX_PENDING_REQUESTS, MAX_INVITES_OUT, MAX_INVITES_IN, INVITE_TTL_MS, NAME_MAX_LEN,
} from '../shared/constants.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

/** Collects warn/error lines so a test can assert what the store said. */
function captureLog() {
  const warns = [];
  const errors = [];
  return {
    warns,
    errors,
    log: {
      info() {}, debug() {},
      warn: (...a) => warns.push(a.map(String).join(' ')),
      error: (...a) => errors.push(a.map(String).join(' ')),
    },
  };
}

/** A mutable fake clock with a real-ish base so timestamps look sane. */
function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, set: (v) => { t = v; }, add: (ms) => { t += ms; } };
}

const mk = (store, name, addrKey = null) => {
  const r = store.create({ name, addrKey });
  assert.equal(r.ok, true, `create(${name}): ${JSON.stringify(r)}`);
  return r;
};

/** Two eligible, mutually-requested accounts → a real friendship (exercises the store's own rules). */
function befriend(store, a, b) {
  store.recordPlayed([a.id, b.id]);
  assert.equal(store.requestFriend(a, b.id).ok, true);
  assert.equal(store.requestFriend(b, a.id).ok, true);
  assert.equal(store.areFriends(a, b.id), true);
  assert.equal(store.areFriends(b, a.id), true);
}

describe('AccountStore', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-')); });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  // -------------------------------------------------------------------------------------------------
  describe('create', () => {
    test('mints a 39-char formatted key, an a_+20-hex id and a normalised name', () => {
      const store = new AccountStore({ file: null, log: silent, now: fakeClock().now });
      const { account, key } = mk(store, '  Ａlice  ');
      assert.equal(key.length, 39);
      assert.equal(formatKey(key), key, 'formatKey is idempotent on the display form');
      assert.equal(canonicalKey(key).length, 32, '32 Crockford base32 chars / 160 bits');
      assert.match(key, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){7}$/);
      assert.match(account.id, /^a_[0-9a-f]{20}$/);
      // NFKC folds full-width letters; whitespace collapses and trims
      assert.equal(account.name, 'Alice');
      assert.equal(account.name, normalizeName('  Ａlice  '));
      assert.equal(store.size, 1);
    });

    test('rejects an empty / non-string / whitespace-only name with BAD_MSG', () => {
      const store = new AccountStore({ file: null, log: silent });
      for (const name of ['', '   ', null, 42, {}, [], '\u200B\u200B']) {
        const r = store.create({ name });
        assert.deepEqual(r, { error: ERR.BAD_MSG, detail: 'empty name' }, JSON.stringify(name));
      }
      assert.equal(store.size, 0);
    });

    test('NAME_TAKEN is case- and width-insensitive (nameKey)', () => {
      const store = new AccountStore({ file: null, log: silent });
      mk(store, 'Fang');
      assert.equal(nameKey('ＦＡＮＧ'), nameKey('Fang'));
      for (const dup of ['fang', 'FANG', 'ＦＡＮＧ', '  Fang  ']) {
        assert.deepEqual(store.create({ name: dup }), { error: ERR.NAME_TAKEN }, dup);
      }
      assert.equal(store.size, 1);
      assert.ok(mk(store, 'Fang2').account.id);
    });

    test('enforces the per-account cap with TOO_MANY', () => {
      const store = new AccountStore({ file: null, log: silent, maxAccounts: 2 });
      mk(store, 'a');
      mk(store, 'b');
      const r = store.create({ name: 'c' });
      assert.equal(r.error, ERR.TOO_MANY);
      assert.equal(store.size, 2);
    });

    test('enforces the per-address hourly creation rate and survives a backwards clock', () => {
      const clock = fakeClock(10_000);
      const store = new AccountStore({ file: null, log: silent, now: clock.now, createPerAddrPerHour: 2 });
      mk(store, 'a', 'net-1');
      mk(store, 'b', 'net-1');
      assert.equal(store.create({ name: 'c', addrKey: 'net-1' }).error, ERR.RATE);
      // a different address is unaffected
      assert.ok(mk(store, 'd', 'net-2').account.id);
      // the window rolls after an hour
      clock.add(3_600_001);
      assert.ok(mk(store, 'e', 'net-1').account.id);
      // ... but a clock that jumps backwards must not wedge the window forever
      assert.ok(mk(store, 'f', 'net-1').account.id);
      assert.equal(store.create({ name: 'g', addrKey: 'net-1' }).error, ERR.RATE);
      clock.set(clock.now() - 60_000); // backwards jump: a new window starts, else this address is stuck at RATE
      assert.ok(mk(store, 'h', 'net-1').account.id, 'backwards clock starts a fresh window');
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('login', () => {
    test('the right key works, twice (two devices); the key is never stored in clear', () => {
      const store = new AccountStore({ file: null, log: silent });
      const { account, key } = mk(store, 'Fang');
      const canonical = canonicalKey(key);
      for (let i = 0; i < 2; i++) {
        const r = store.login(key);
        assert.equal(r.ok, true);
        assert.equal(r.account.id, account.id, 'same account from two "devices"');
      }
      const json = JSON.stringify(store.serialize());
      assert.equal(json.includes(key), false, 'formatted key absent from the file');
      assert.equal(json.includes(canonical), false, 'canonical key absent from the file');
      assert.equal(account.keyHash.length, 64);
      assert.match(account.keyHash, /^[0-9a-f]{64}$/);
    });

    test('wrong, malformed, empty, null and wrong-length keys answer the SAME code (no oracle)', () => {
      const store = new AccountStore({ file: null, log: silent });
      const { account, key } = mk(store, 'Fang');
      const canonical = canonicalKey(key);
      // a key that is well-formed but unknown (one char of the canonical form changed)
      const unknown = (canonical[0] === '0' ? '1' : '0') + canonical.slice(1);
      const answers = [
        store.login(unknown),             // well-formed but unknown
        store.login('not a key!!'),       // malformed
        store.login(''),                  // empty
        store.login(null),                // null
        store.login(undefined),           // undefined
        store.login({}),                  // object
        store.login(account.id),          // the public id is not a key
        store.login(canonical.slice(0, 31)), // one char short
        store.login(canonical + 'A'),     // one char long
        store.login(12345),               // number
      ];
      const codes = answers.map((r) => r.error);
      assert.deepEqual(new Set(codes), new Set([ERR.ACCOUNT_BAD_KEY]), JSON.stringify(codes));
      assert.ok(answers.every((r) => !r.ok));
      assert.equal(store.login(key).ok, true, 'the real key still works');
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('rename', () => {
    test('normalises, refuses a taken name, and treats a no-op rename as ok', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'Fang').account;
      const b = mk(store, 'Bob').account;
      assert.equal(store.rename(a, '  Ｃarol ').ok, true);
      assert.equal(a.name, 'Carol');
      assert.deepEqual(store.rename(b, 'carol'), { error: ERR.NAME_TAKEN });
      assert.deepEqual(store.rename(b, 'ＣＡＲＯＬ'), { error: ERR.NAME_TAKEN });
      assert.equal(store.rename(b, 'bob').ok, true, 'renaming to the same name is a no-op ok');
      assert.equal(b.name, 'bob');
      assert.equal(store.rename(b, '   ').error, ERR.BAD_MSG);
      assert.equal(store.rename(null, 'x').error, ERR.INTERNAL);
      // Regression guard: a rename used to leave the OLD nameKey in `byName`, reserving the abandoned name forever
      // (and growing the map with every rename). It must be freed, and a case-only change must reuse the key.
      assert.equal(store.byName.get(nameKey('Fang')), undefined, 'the old name key is freed');
      assert.ok(store.create({ name: 'Fang' }).ok, 'the abandoned name becomes available again');
      const c = mk(store, 'Casey').account;
      assert.equal(store.rename(c, 'CASEY').ok, true);
      assert.equal(store.byName.get('casey'), c.id, 'a case-only rename reuses the same key');
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('rotate', () => {
    test('the old key stops working, the new one works, the store only returns the key', () => {
      const store = new AccountStore({ file: null, log: silent });
      const { account, key } = mk(store, 'Fang');
      const res = store.rotate(account);
      assert.equal(res.ok, true);
      assert.equal(res.key.length, 39);
      assert.notEqual(res.key, key);
      assert.equal(store.login(key).error, ERR.ACCOUNT_BAD_KEY, 'old key dead');
      assert.equal(store.login(res.key).ok, true, 'new key works');
      assert.equal(store.login(res.key).account.id, account.id);
      assert.equal(store.rotate(null).error, ERR.INTERNAL);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('played-together ledger', () => {
    test('only a real pairing records; a solo match records nothing', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      assert.equal(store.recordPlayed([a.id]), 0, 'one human = no pairing');
      assert.equal(store.recordPlayed([a.id, a.id]), 0, 'deduplicated to one');
      assert.equal(store.recordPlayed([a.id, 'a_deadbeefdeadbeefdead', null, undefined]), 0, 'unknown ids filtered');
      assert.equal(store.recordPlayed([a.id, b.id]), 2, 'pairwise, both directions');
      assert.equal(store.recordPlayed([a.id, b.id, c.id]), 6, '3 humans → 6 directed edges');
      assert.equal(a.playedWith.size, 2);
      assert.deepEqual(store.recordPlayed(null), 0);
    });

    test('isEligible is bounded by MET_TTL_MS and metList hides friends / pending', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      const d = mk(store, 'd').account;
      store.recordPlayed([a.id, b.id, c.id, d.id]);
      assert.equal(store.isEligible(a, b.id), true);
      assert.equal(store.isEligible(a, 'a_nope'), false);
      assert.equal(store.isEligible(null, b.id), false);
      assert.equal(store.isEligible(a, 42), false);
      // C becomes a friend, D gets a pending request → both leave the met list
      assert.equal(store.requestFriend(a, c.id).ok, true);
      assert.equal(store.requestFriend(c, a.id).ok, true);
      assert.equal(store.requestFriend(a, d.id).ok, true);
      assert.deepEqual(store.metList(a).map((m) => m.accountId), [b.id]);
      // inside the TTL
      clock.add(90 * 24 * 60 * 60 * 1000);
      assert.equal(store.isEligible(a, b.id), true, 'exactly at the TTL boundary');
      clock.add(1);
      assert.equal(store.isEligible(a, b.id), false);
      assert.deepEqual(store.metList(a), []);
      assert.equal(store.requestFriend(a, b.id).error, ERR.NOT_ELIGIBLE, 'an expired edge cannot be friended');
    });

    test('metList caps at maxMet keeping the NEWEST partners (regression)', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now, maxMet: 3 });
      const a = mk(store, 'a').account;
      const partners = [];
      for (let i = 0; i < 6; i++) {
        const p = mk(store, `p${i}`).account;
        partners.push(p);
        clock.add(1000);
        store.recordPlayed([a.id, p.id]);
      }
      assert.equal(a.playedWith.size, 3, 'the ledger itself is pruned');
      assert.deepEqual(store.metList(a).map((m) => m.name), ['p5', 'p4', 'p3'], 'newest kept, oldest dropped');
      assert.equal(store.metList(a)[0].at, Math.max(...partners.map((p) => a.playedWith.get(p.id) || 0)));
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('friends', () => {
    test('a stranger and yourself are refused', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      assert.equal(store.requestFriend(a, b.id).error, ERR.NOT_ELIGIBLE);
      assert.equal(store.requestFriend(a, a.id).error, ERR.BAD_TARGET);
      assert.equal(store.requestFriend(a, 'a_nope').error, ERR.BAD_TARGET);
      assert.equal(store.requestFriend(a, '__proto__').error, ERR.BAD_TARGET);
      assert.equal(store.requestFriend(null, b.id).error, ERR.INTERNAL);
      assert.equal(store.areFriends(a, b.id), false);
    });

    test('a mutual request auto-accepts; ALREADY once friends', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      store.recordPlayed([a.id, b.id]);
      assert.deepEqual(store.requestFriend(a, b.id), { ok: true, accepted: false });
      assert.equal(store.areFriends(b, a.id), false);
      const mirror = store.requestFriend(b, a.id);
      assert.equal(mirror.ok, true);
      assert.equal(store.areFriends(a, b.id), true, 'the store links the pair');
      assert.equal(store.areFriends(b, a.id), true);
      assert.equal(a.outgoing.size, 0, 'pending state cleaned up');
      assert.equal(b.incoming.size, 0);
      assert.equal(store.requestFriend(a, b.id).error, ERR.ALREADY);
      assert.equal(store.requestFriend(b, a.id).error, ERR.ALREADY);
      // Regression guard: the mirror request must keep the `accepted` request shape. Returning acceptFriend's
      // `{ ok, added }` would make Lobby.friendRequest take the "pending" branch and send a spurious friend.request.
      assert.deepEqual(mirror, { ok: true, accepted: true }, 'the mirror reports the accept');
    });

    test('acceptFriend is idempotent and refuses a request that is not there', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      befriend(store, a, b);
      assert.deepEqual(store.acceptFriend(a, b.id), { ok: true, added: false });
      const c = mk(store, 'c').account;
      assert.equal(store.acceptFriend(a, c.id).error, ERR.BAD_TARGET);
    });

    test('TOO_MANY at MAX_FRIENDS (own and target side)', () => {
      const store = new AccountStore({ file: null, log: silent, maxFriends: 1 });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      store.recordPlayed([a.id, b.id, c.id]);
      befriend(store, a, b);
      assert.equal(a.friends.size, 1);
      assert.equal(store.requestFriend(a, c.id).error, ERR.TOO_MANY);
      // the target side is capped too: C may not grow past its own maxFriends=1 either
      assert.equal(store.requestFriend(c, a.id).error, ERR.TOO_MANY);
      assert.equal(c.friends.size, 0);
    });

    test(`TOO_MANY at MAX_PENDING_REQUESTS (${MAX_PENDING_REQUESTS})`, () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const targets = [];
      for (let i = 0; i < MAX_PENDING_REQUESTS + 2; i++) targets.push(mk(store, `t${i}`).account);
      store.recordPlayed([a.id, ...targets.map((t) => t.id)]);
      let ok = 0;
      for (const t of targets) {
        const r = store.requestFriend(a, t.id);
        if (r.ok) ok++;
        else { assert.equal(r.error, ERR.TOO_MANY, JSON.stringify(r)); break; }
      }
      assert.equal(ok, MAX_PENDING_REQUESTS);
      assert.equal(a.outgoing.size, MAX_PENDING_REQUESTS);
    });

    test('declineFriend sets a cooldown, then the request is allowed again', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      store.recordPlayed([a.id, b.id]);
      assert.equal(store.requestFriend(a, b.id).ok, true);
      assert.deepEqual(store.declineFriend(b, a.id), { ok: true, removed: true });
      assert.equal(b.declined.has(a.id), true, 'the decliner records the cooldown');
      assert.equal(store.requestFriend(a, b.id).error, ERR.DECLINED, 'immediate re-request refused');
      clock.add(DECLINE_COOLDOWN_MS - 1);
      assert.equal(store.requestFriend(a, b.id).error, ERR.DECLINED);
      clock.add(1);
      assert.equal(store.requestFriend(a, b.id).ok, true, 'allowed again after the cooldown');
      assert.equal(store.requestFriend(b, a.id).ok, true, 'and B may accept');
      assert.equal(store.areFriends(a, b.id), true);
      assert.equal(b.declined.has(a.id), false, 'linking clears the cooldown');
    });

    test('removeFriend is symmetric and clears pending state', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      befriend(store, a, b);
      assert.deepEqual(store.removeFriend(a, b.id), { ok: true, removed: true });
      assert.equal(store.areFriends(a, b.id), false);
      assert.equal(store.areFriends(b, a.id), false);
      assert.equal(store.removeFriend(a, b.id).ok, true);
      assert.equal(store.removeFriend(a, b.id).removed, false);
      // removing someone who is not a friend is a safe no-op (no existence oracle)
      assert.equal(store.removeFriend(a, 'a_nope').removed, false);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('invites', () => {
    test('refuses a non-friend, yourself and a missing room code', () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      assert.equal(store.createInvite(a, b.id, { code: 'ABCD' }).error, ERR.NOT_FRIEND);
      assert.equal(store.createInvite(a, a.id, { code: 'ABCD' }).error, ERR.BAD_TARGET);
      befriend(store, a, b);
      assert.equal(store.createInvite(a, b.id, { code: '' }).error, ERR.BAD_MSG);
      assert.equal(store.createInvite(a, b.id, {}).error, ERR.BAD_MSG);
    });

    test('refreshes the same invite for the same room instead of stacking', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      befriend(store, a, b);
      const first = store.createInvite(a, b.id, { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', players: 1 });
      assert.equal(first.ok, true);
      assert.equal(store.createInvite(a, b.id, { code: 'ABCD' }).error, ERR.RATE, 'per-pair cooldown');
      clock.add(20_001);
      const again = store.createInvite(a, b.id, { code: 'ABCD', mode: 'coop', difficulty: 'NORMAL', players: 3 });
      assert.equal(again.ok, true);
      assert.equal(again.invite.inviteId, first.invite.inviteId, 'same invite id, refreshed');
      assert.equal(store.invitesFor(b.id).length, 1);
      assert.equal(again.invite.players, 3, 'refreshed occupancy');
      // a different room code is a genuinely new invite for the same pair
      clock.add(20_001);
      const other = store.createInvite(a, b.id, { code: 'WXYZ' });
      assert.equal(other.ok, true);
      assert.notEqual(other.invite.inviteId, first.invite.inviteId);
      assert.equal(store.invitesFor(b.id).length, 2);
    });

    test(`caps one account at MAX_INVITES_OUT (${MAX_INVITES_OUT}) open invites`, () => {
      const store = new AccountStore({ file: null, log: silent });
      const a = mk(store, 'a').account;
      const friends = [];
      for (let i = 0; i < MAX_INVITES_OUT + 1; i++) {
        const f = mk(store, `f${i}`).account;
        befriend(store, a, f);
        friends.push(f);
      }
      let ok = 0;
      for (let i = 0; i < friends.length; i++) {
        const r = store.createInvite(a, friends[i].id, { code: `R${String(i).padStart(3, '0')}` });
        if (r.ok) ok++;
        else { assert.equal(r.error, ERR.TOO_MANY, JSON.stringify(r)); break; }
      }
      assert.equal(ok, MAX_INVITES_OUT);
      assert.equal(store.invitesOut.get(a.id).size, MAX_INVITES_OUT);
    });

    test(`shows at most MAX_INVITES_IN (${MAX_INVITES_IN}) invites to one account`, () => {
      const store = new AccountStore({ file: null, log: silent });
      const recipient = mk(store, 'r').account;
      for (let i = 0; i < MAX_INVITES_IN + 1; i++) {
        const sender = mk(store, `s${i}`).account;
        befriend(store, sender, recipient);
        const r = store.createInvite(sender, recipient.id, { code: `C${String(i).padStart(3, '0')}` });
        assert.equal(r.ok, true, `sender ${i}: ${JSON.stringify(r)}`);
      }
      assert.equal(store.invitesIn.get(recipient.id).size, MAX_INVITES_IN, 'old ones are dropped');
      assert.equal(store.invitesFor(recipient.id).length, MAX_INVITES_IN);
    });

    test('takeInvite is recipient-bound, single-use and opaque on every failure', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      befriend(store, a, b);
      befriend(store, a, c);
      befriend(store, b, c);
      const inv = store.createInvite(a, b.id, { code: 'ABCD' });
      const failures = [
        ['foreign', store.takeInvite(c.id, inv.invite.inviteId)],
        ['sender-is-not-recipient', store.takeInvite(a.id, inv.invite.inviteId)],
        ['unknown', store.takeInvite(b.id, 'i_deadbeefdeadbeefdeadbeef')],
        ['lookup-key', store.takeInvite(b.id, '__proto__')],
      ];
      for (const [label, r] of failures) {
        assert.equal(r.error, ERR.INVITE_GONE, label);
        assert.equal(r.detail, undefined, `${label} carries no detail`);
      }
      assert.equal(store.takeInvite(b.id, inv.invite.inviteId).ok, true, 'the recipient may take it');
      assert.equal(store.takeInvite(b.id, inv.invite.inviteId).error, ERR.INVITE_GONE, 'replay');
      // expiry is the same answer: create a distinct pair, advance past the TTL
      clock.add(20_001);
      const second = store.createInvite(b, c.id, { code: 'EFGH' });
      assert.equal(second.ok, true);
      clock.add(INVITE_TTL_MS + 1);
      const expired = store.takeInvite(c.id, second.invite.inviteId);
      assert.equal(expired.error, ERR.INVITE_GONE, 'expired');
      assert.equal(expired.detail, undefined);
    });

    test('invitesForRoom / dropInvitesForRoom / declineInvite', () => {
      const clock = fakeClock(0);
      const store = new AccountStore({ file: null, log: silent, now: clock.now });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      befriend(store, a, b);
      befriend(store, a, c);
      const i1 = store.createInvite(a, b.id, { code: 'ROOM' });
      const i2 = store.createInvite(a, c.id, { code: 'ROOM' });
      assert.equal(store.invitesForRoom('ROOM').length, 2);
      const dropped = store.dropInvitesForRoom('ROOM');
      assert.equal(dropped.length, 2);
      assert.equal(store.invitesForRoom('ROOM').length, 0);
      assert.equal(store.invitesFor(b.id).length, 0);
      assert.equal(store.invitesOut.get(a.id)?.size || 0, 0, 'both indices cleaned');
      // declineInvite tells the sender which invite it was, and only the recipient may decline
      clock.add(20_001);
      const i3 = store.createInvite(a, b.id, { code: 'NEXT' });
      assert.equal(store.declineInvite(c.id, i3.invite.inviteId).error, ERR.INVITE_GONE);
      const dec = store.declineInvite(b.id, i3.invite.inviteId);
      assert.equal(dec.ok, true);
      assert.equal(dec.invite.inviteId, i3.invite.inviteId);
      assert.equal(dec.invite.from, a.id);
      assert.equal(store.takeInvite(b.id, i3.invite.inviteId).error, ERR.INVITE_GONE);
      void i1; void i2;
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('persistence', () => {
    /** A store with a couple of accounts, a friendship, a pending request, a met ledger and an invite. */
    function populated(nowFn) {
      const store = new AccountStore({ file: null, log: silent, now: nowFn });
      const a = mk(store, 'Fang').account;
      const b = mk(store, 'Bob').account;
      const c = mk(store, 'Carol').account;
      store.recordPlayed([a.id, b.id, c.id]);
      befriend(store, a, b);
      store.requestFriend(a, c.id);
      store.createInvite(a, b.id, { code: 'ABCD', mode: 'coop', difficulty: 'HARD' });
      return { store, a, b, c };
    }

    test('serialize() → load() round-trips accounts, friends, pending and the met ledger', () => {
      const clock = fakeClock(1_000_000);
      const { store, a, b, c } = populated(clock.now);
      const file = path.join(tmp, 'roundtrip.json');
      fs.writeFileSync(file, JSON.stringify(store.serialize()));
      const loaded = new AccountStore({ file, log: silent, now: clock.now });
      assert.equal(loaded.size, 3);
      const la = loaded.get(a.id);
      const lb = loaded.get(b.id);
      const lc = loaded.get(c.id);
      assert.equal(la.name, 'Fang');
      assert.equal(loaded.areFriends(la, lb.id), true);
      assert.equal(loaded.areFriends(lb, la.id), true);
      assert.equal(la.outgoing.has(c.id), true);
      assert.equal(lc.incoming.has(a.id), true);
      assert.equal(la.playedWith.get(lb.id), a.playedWith.get(b.id), 'met timestamps survive');
      assert.equal(loaded.invitesFor(b.id).length, 0, 'invites are ephemeral (120 s) and are not persisted');
      assert.equal(loaded.stats().friendEdges, 1);
      assert.equal(loaded.serialize().accounts[la.id].friends.length, a.friends.size);
    });

    test('a missing file is fine (first boot)', () => {
      const store = new AccountStore({ file: path.join(tmp, 'does-not-exist.json'), log: silent });
      assert.equal(store.size, 0);
      assert.equal(store.loadWarning, null);
    });

    test('an astral-character (emoji) name survives the round trip', () => {
      // Regression guard (this used to fail): `#revive` rejected a record when `name.length > NAME_MAX_LEN`, but
      // `name.length` counts UTF-16 code units while `normalizeName` caps at NAME_MAX_LEN CODE POINTS. A name of
      // 7 emoji (7 code points, 14 code units) was created happily and written, then silently dropped on the next
      // boot, locking the player out. The check now counts code points.
      const store = new AccountStore({ file: null, log: silent });
      const name = '😀'.repeat(7);
      const r = mk(store, name);
      assert.equal([...r.account.name].length, 7, 'within the 12 code-point cap');
      assert.ok(r.account.name.length > NAME_MAX_LEN, 'but longer than 12 UTF-16 units (the precondition)');
      const file = path.join(tmp, 'astral.json');
      fs.writeFileSync(file, JSON.stringify(store.serialize()));
      const loaded = new AccountStore({ file, log: silent });
      assert.equal(loaded.size, 1, 'the account must survive a reload');
      assert.equal(loaded.login(r.key).ok, true, 'and its key must still work');
    });

    test('a corrupt / oversized / future / wrong-shape file is quarantined, never thrown on', () => {
      const cap = captureLog();
      const write = (name, content) => {
        const p = path.join(tmp, name);
        fs.writeFileSync(p, content);
        return p;
      };
      const cases = [
        ['unparseable.json', '{not json at all'],
        ['array.json', '[1,2,3]'],
        ['scalar.json', '"just a string"'],
        ['null.json', 'null'],
        ['future.json', JSON.stringify({ v: ACCOUNT_FILE_VERSION + 1, accounts: {} })],
        ['no-version.json', JSON.stringify({ accounts: {} })],
      ];
      for (const [name, content] of cases) {
        const p = write(name, content);
        const store = new AccountStore({ file: p, log: cap.log });
        assert.equal(store.size, 0, name);
        assert.ok(store.loadWarning, `${name} sets a warning`);
        assert.equal(fs.existsSync(p), false, `${name} moved aside`);
        const aside = fs.readdirSync(tmp).filter((f) => f.startsWith(`${name}.corrupt-`));
        assert.equal(aside.length, 1, `${name} quarantined`);
      }
      // oversized: a sparse > 64 MB file is never parsed and never overwritten
      const big = path.join(tmp, 'oversized.json');
      fs.writeFileSync(big, 'x');
      fs.truncateSync(big, MAX_ACCOUNT_FILE_BYTES + 1);
      const bigStore = new AccountStore({ file: big, log: cap.log });
      assert.equal(bigStore.size, 0);
      assert.equal(bigStore.loadWarning, 'oversized');
      assert.equal(fs.existsSync(big), false);
      assert.ok(cap.errors.length >= cases.length, 'each quarantine is loud in the log');
    });

    test('a mismatched pepperTag keeps the accounts but warns', () => {
      const cap = captureLog();
      const clock = fakeClock(5000);
      const { store, a } = populated(clock.now);
      const file = path.join(tmp, 'pepper.json');
      const data = store.serialize();
      data.pepperTag = '0000000000000000'; // another deployment's pepper
      fs.writeFileSync(file, JSON.stringify(data));
      const loaded = new AccountStore({ file, log: cap.log, keyPepper: 'a-different-pepper' });
      assert.equal(loaded.size, 3, 'accounts are kept, not dropped');
      assert.equal(loaded.get(a.id).name, 'Fang');
      assert.equal(loaded.loadWarning, 'pepper-changed');
      assert.ok(cap.warns.some((w) => /SP_KEY_PEPPER changed/.test(w)), 'operator is warned');
    });

    test('a hand-edited file with __proto__ keys or an array of accounts is ignored safely', () => {
      const protoNamesBefore = Object.getOwnPropertyNames(Object.prototype).sort();
      const protoFile = path.join(tmp, 'proto.json');
      fs.writeFileSync(protoFile, `{"v":${ACCOUNT_FILE_VERSION},"accounts":{"__proto__":{"name":"evil","keyHash":"${'a'.repeat(64)}"}}}`);
      const store = new AccountStore({ file: protoFile, log: silent });
      assert.equal(store.size, 0);
      assert.equal(store.loadWarning, null, 'well-formed JSON, just no valid account records');
      assert.equal(({}).polluted, undefined);
      assert.equal(Object.prototype.polluted, undefined);
      assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), protoNamesBefore, 'Object.prototype untouched');
      const arrFile = path.join(tmp, 'accounts-array.json');
      fs.writeFileSync(arrFile, JSON.stringify({ v: ACCOUNT_FILE_VERSION, accounts: [{ name: 'x', keyHash: 'b'.repeat(64) }] }));
      const arrStore = new AccountStore({ file: arrFile, log: silent });
      assert.equal(arrStore.size, 0);
      assert.equal(Object.prototype.polluted, undefined);
    });
  });

  // -------------------------------------------------------------------------------------------------
  describe('stats', () => {
    test('has the documented shape and counts edges, not directed halves', async () => {
      const store = new AccountStore({ file: null, log: silent });
      assert.deepEqual(store.stats(), {
        accounts: 0, friendEdges: 0, metEdges: 0, pendingRequests: 0, invites: 0, persisted: false,
      });
      const a = mk(store, 'a').account;
      const b = mk(store, 'b').account;
      const c = mk(store, 'c').account;
      store.recordPlayed([a.id, b.id, c.id]);
      befriend(store, a, b);
      store.requestFriend(a, c.id);
      store.createInvite(a, b.id, { code: 'ABCD' });
      assert.deepEqual(store.stats(), {
        accounts: 3, friendEdges: 1, metEdges: 3, pendingRequests: 1, invites: 1, persisted: false,
      });
      const persisted = new AccountStore({ file: path.join(tmp, 'stats.json'), log: silent });
      persisted.create({ name: 'z' });
      assert.equal(persisted.stats().persisted, true);
      await persisted.close();
    });

    test('respects NAME_MAX_LEN after normalisation', () => {
      const store = new AccountStore({ file: null, log: silent });
      const long = 'x'.repeat(NAME_MAX_LEN + 20);
      const r = mk(store, long);
      assert.equal([...r.account.name].length, NAME_MAX_LEN);
    });
  });
});
