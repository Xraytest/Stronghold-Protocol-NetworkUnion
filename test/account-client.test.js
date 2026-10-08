// test/account-client.test.js — public/js/account.js, the client half of the account layer (DESIGN §27.3). The
// interesting part is the session bootstrap: the title screen is a guest whose socket has NOT said hello yet, so the
// first account action taken there has to say hello itself before `net.request` will accept anything (OFFLINE
// otherwise). A fake net/store is installed into the singleton, so this needs no browser and no server.
// Run: node --test test/account-client.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { account, K_ACCOUNT } from '../public/js/account.js';
import { ERR } from '../shared/constants.js';

/** A stand-in for public/js/net.js: records hello call-signs and requests, and lets a test finish the handshake. */
function fakeNet(status = 'connected') {
  const listeners = new Map();
  const calls = { setName: [], request: [] };
  return {
    status, calls,
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    emit(type, payload) { for (const fn of [...(listeners.get(type) || [])]) fn(payload); },
    setName(name) { calls.setName.push(name); this.status = 'handshaking'; },
    async request(t, fields) { calls.request.push({ t, fields }); return {}; },
    /** The server accepted the hello. */
    accept() { this.status = 'online'; this.emit('status', { status: 'online' }); },
    /** The socket died while the intent was waiting. */
    die() { this.status = 'closed'; this.emit('status', { status: 'closed' }); },
  };
}

/** A stand-in for public/js/store.js with just the `account` slice the layer touches. */
function fakeStore(slice = {}) {
  const state = { account: { accountId: null, name: null, incoming: [], invites: [], ...slice } };
  const patches = [];
  return {
    state, patches,
    get: () => state,
    patch(key, obj) { patches.push({ key, obj }); state[key] = { ...state[key], ...obj }; },
  };
}

/** Install the singleton against fresh fakes (and forget any cached account record of an earlier test). */
function install(net, store, stored = null) {
  account.uninstall();
  account.install({ net, store });
  // after install(): install() reads the real cache itself, which does not exist under node --test
  account.stored = stored;
  return { net, store };
}

test('online: a live session is left alone', async () => {
  const { net } = install(fakeNet('online'), fakeStore());
  assert.equal(await account.online('Amiya'), true);
  assert.deepEqual(net.calls.setName, []);
  assert.deepEqual(net.calls.request, []);
  account.uninstall();
});

test('online: a guest tab says hello itself, then resolves once the server reports online', async () => {
  const { net } = install(fakeNet('connected'), fakeStore());
  const wait = account.online('Amiya');
  // hello goes out immediately (net.setName is the hello path: net.request('hello') is refused by design)
  assert.deepEqual(net.calls.setName, ['Amiya']);
  let settled = false;
  wait.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false, 'still waiting for the welcome');
  net.accept();
  assert.equal(await wait, true);
  account.uninstall();
});

test('online: without a typed call-sign it falls back to the account name, then the cached key, then the generic one', async () => {
  // the store's account name (a session that is logged in but not connected yet)
  let { net } = install(fakeNet('connected'), fakeStore({ accountId: 'a_1', name: 'Kaltsit' }));
  await Promise.all([account.online(), (async () => { await Promise.resolve(); net.accept(); })()]);
  assert.deepEqual(net.calls.setName, ['Kaltsit']);

  // the cached record of a past login
  ({ net } = install(fakeNet('connected'), fakeStore(), { key: 'A'.repeat(32), accountId: 'a_2', name: 'Cached' }));
  await Promise.all([account.online(), (async () => { await Promise.resolve(); net.accept(); })()]);
  assert.deepEqual(net.calls.setName, ['Cached']);

  // nothing at all — logging in with a key from a blank title screen must still work: the server replaces this
  // placeholder with the account's own name the moment the key binds (it is never shown anywhere)
  ({ net } = install(fakeNet('connected'), fakeStore()));
  await Promise.all([account.online(), (async () => { await Promise.resolve(); net.accept(); })()]);
  assert.equal(net.calls.setName.length, 1);
  assert.ok(net.calls.setName[0].trim().length > 0, 'a placeholder call-sign, never an empty hello');
  account.uninstall();
});

test('online: a socket that closes while waiting rejects instead of hanging', async () => {
  const { net } = install(fakeNet('connected'), fakeStore());
  const wait = account.online('Amiya');
  net.die();
  await assert.rejects(wait, (err) => err && err.code === 'CLOSED');
  account.uninstall();
});

test('online: a refused hello fails with the server reason right away', async () => {
  const { net } = install(fakeNet('connecting'), fakeStore());
  const wait = account.online('Amiya');
  const refused = Object.assign(new Error('version mismatch: server 3'), { code: ERR.BAD_MSG });
  net.emit('helloError', refused);
  await assert.rejects(wait, (err) => err === refused, 'the real reason, not an OFFLINE after 8 s');
  // the listeners are gone with it: a late welcome must not resurrect a settled intent
  net.accept();
  assert.deepEqual(net.calls.setName, ['Amiya']);
  account.uninstall();
});

test('create: hello first, then the request', async () => {
  const { net } = install(fakeNet('connected'), fakeStore());
  const wait = account.create('  Amiya  ');   // the account name is normalised (trimmed) for both
  await Promise.resolve();
  net.accept();
  await wait;
  assert.deepEqual(net.calls.setName, ['Amiya']);
  assert.deepEqual(net.calls.request, [{ t: 'account.create', fields: { name: 'Amiya' } }]);
  account.uninstall();
});

test('login: canonicalises the key, says hello with the title call-sign, and refuses a malformed key locally', async () => {
  const { net } = install(fakeNet('connected'), fakeStore());
  const spelled = 'abcd-efgh-jkmn-pqrs-tvwx-yz01-2345-6789';
  const wait = account.login(spelled, 'Amiya');
  await Promise.resolve();
  net.accept();
  await wait;
  assert.deepEqual(net.calls.setName, ['Amiya'], 'the title call-sign is what the hello carries');
  assert.equal(net.calls.request.length, 1);
  assert.equal(net.calls.request[0].t, 'account.login');
  assert.equal(net.calls.request[0].fields.key, 'ABCDEFGHJKMNPQRSTVWXYZ0123456789'.slice(0, 32), 'canonical (bare, uppercase)');
  assert.ok(!net.calls.request[0].fields.key.includes('-'), 'separators are stripped');

  // a key that cannot be a key never reaches the network
  await assert.rejects(() => account.login('nope'), (err) => err && err.message === 'BAD_KEY_FORMAT');
  assert.equal(net.calls.request.length, 1);
  account.uninstall();
});

test('friend and invite intents without an account never touch the network', async () => {
  const { net, store } = install(fakeNet('online'), fakeStore());
  await account.sync();
  await account.logout();
  assert.deepEqual(net.calls.request, []);
  assert.deepEqual(store.patches, []);
  // with an account id, sync asks the server (the session is already online, so no hello)
  store.state.account.accountId = 'a_3';
  await account.sync();
  assert.deepEqual(net.calls.request, [{ t: 'friend.sync', fields: undefined }]);
  assert.deepEqual(net.calls.setName, []);
  account.uninstall();
});

test('online: a non-online, non-closed status (still handshaking) keeps waiting', async () => {
  const { net } = install(fakeNet('connecting'), fakeStore());
  const wait = account.online('Amiya');
  net.emit('status', { status: 'handshaking' });
  net.emit('status', { status: 'reconnecting' });
  net.accept();
  assert.equal(await wait, true);
  account.uninstall();
});

test('the cached record slot is a stable key', () => {
  assert.equal(K_ACCOUNT, 'sp.account');
  assert.ok(ERR.ACCOUNT_BAD_KEY, 'the wire error the layer surfaces is the protocol one');
});
