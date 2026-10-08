// test/e2e/social.e2e.mjs — the DESIGN §27 account / friend / quick-invite flow in two real browsers against a real
// server (`node server/index.js`), driven through the actual UI: key login on the title screen, the played-together
// ledger → friend request → accept, a friend-visible coop room, the invite popup on the other side and the join.
//
// Not a `node --test` file (it needs Chrome and takes ~90 s): run it by hand.
//   CHROME_PATH=/path/to/chrome node test/e2e/social.e2e.mjs      (SP_E2E=1 is implied outside the test runner)
// The checkout has no art (public/assets is fetched, not tracked), so missing-art 404s are ignored; every console
// error, page error and failed request that is NOT an asset is reported and fails the run.
//
// It seeds its own account file (SP_ACCOUNTS_FILE + SP_KEY_PEPPER in a temp dir) rather than writing state/ in the
// repository. Two accounts share a `playedWith` ledger entry — "they finished a battle together" — which is exactly
// the one and only door to a friendship (DESIGN §27.3), and the keys are generated here so the test can log in.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Client, ROOT, sleep, hasChrome, startRealServer, problemsOf } from './client.mjs';
import { encodeKey, canonicalKey, formatKey } from '../../shared/accountKey.js';

const ENABLED = (process.env.SP_E2E === '1' || !process.env.NODE_TEST_CONTEXT) && hasChrome();
const PEPPER = 'e2e-pepper';
const KEY_BYTES = 20;

const hashKey = (canonical) => createHash('sha256').update(`${PEPPER}\u0000${canonical}`).digest('hex');
const pepperTag = () => createHash('sha256').update(`pepper:${PEPPER}`).digest('hex').slice(0, 16);

/** Two accounts that have played together but are not friends yet, plus the keys this run logs in with. */
function seedAccounts(dir) {
  const keyA = formatKey(canonicalKey(encodeKey(randomBytes(KEY_BYTES))));
  const keyB = formatKey(canonicalKey(encodeKey(randomBytes(KEY_BYTES))));
  const ids = { A: 'a_' + randomBytes(10).toString('hex'), B: 'a_' + randomBytes(10).toString('hex') };
  const now = Date.now();
  const acct = (name, key, mate) => ({ name, keyHash: hashKey(canonicalKey(key)), friends: [], incoming: [], outgoing: [], playedWith: [[mate, now]], declined: [] });
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(file, JSON.stringify({
    v: 1, savedAt: now, pepperTag: pepperTag(),
    accounts: { [ids.A]: acct('Amiya', keyA, ids.B), [ids.B]: acct('Kaltsit', keyB, ids.A) },
  }));
  return { file, ids, keyA, keyB };
}

/** Everything this test asserts about a client, read out of its real store. */
const slice = (c) => c.page.evaluate(() => {
  const s = globalThis.__SP__.store.get();
  return {
    accountId: s.account.accountId, name: s.account.name, status: s.connection.status,
    friends: s.account.friends.map((f) => `${f.name}:${f.status}:${f.room ? `${f.room.code}${f.room.joinable ? '/join' : ''}` : '-'}`),
    incoming: s.account.incoming.map((r) => r.name),
    outgoing: s.account.outgoing.map((r) => r.name),
    met: s.account.met.map((m) => m.name),
    invites: s.account.invites.map((i) => `${i.fromName}:${i.code}`),
    room: s.room ? { code: s.room.code, mode: s.room.mode, seats: (s.room.seats || []).filter((x) => x && x.playerId).map((x) => x.name) } : null,
  };
});
const text = (c) => c.page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

/** Log in on the title screen through the real UI: 已有密钥 → paste → 登录. */
async function loginVia(c, key) {
  await c.page.evaluate(() => document.querySelector('.acc-row')?.scrollIntoView({ block: 'center' }));
  await c.click('.acc-row .btn', '已有密钥');
  await c.page.waitForFunction(() => !!document.querySelector('.acc-row__key input'), { timeout: 10000 });
  const input = (await c.page.$$('.acc-row__key input'))[0];
  await input.click();
  await input.type(key);
  await c.click('.acc-row__key .btn', '登录');
  for (let i = 0; i < 60; i++) { const s = await slice(c); if (s.accountId) return s; await sleep(250); }
  return slice(c);
}

/** 开始 → the lobby (the title's call-sign comes from the prefill this test also checks). */
async function enterLobby(c) {
  await c.click('.btn', '开始');
  await c.page.waitForFunction(() => !!document.querySelector('.lobby-friends'), { timeout: 25000 });
}

/** Poll `fn` until it is truthy or the deadline passes; returns the last value either way. */
async function until(fn, ms = 10000, step = 250) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) return v;
    await sleep(step);
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-e2e-social-'));
  const { file, ids, keyA, keyB } = seedAccounts(dir);
  process.env.SP_ACCOUNTS_FILE = file;
  process.env.SP_KEY_PEPPER = PEPPER;
  const results = [];
  const check = (name, ok, extra = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra !== '' ? ` — ${extra}` : ''}`);

  const srv = await startRealServer({});
  const A = new Client(await pptr(), srv.base, 'A', { w: 1400, h: 900, prefix: 'social' });
  const B = new Client(await pptr(), srv.base, 'B', { w: 1400, h: 900, prefix: 'social' });
  let failed = false;
  try {
    await A.open(); await B.open();

    // 1. a key logs in on the title screen — the socket has not said hello yet, so account.online() must do it
    const sa = await loginVia(A, keyA);
    check('A: 已有密钥 login bound the account', sa.accountId === ids.A && sa.name === 'Amiya', JSON.stringify(sa));
    const sb = await loginVia(B, keyB);
    check('B: 已有密钥 login bound the account', sb.accountId === ids.B && sb.name === 'Kaltsit', JSON.stringify(sb));
    check('A: the title call-sign prefilled with the account name', (await A.page.$eval('input', (el) => el.value)) === 'Amiya');
    check('A: the played-together ledger is offered (并肩作战)', sa.met.includes('Kaltsit'), JSON.stringify(sa.met));
    check('B: the played-together ledger is offered (并肩作战)', sb.met.includes('Amiya'), JSON.stringify(sb.met));

    // 2. apply for a friendship from the ledger, accept it on the other side (the ledger is the only door)
    await A.click('.acc-row .btn', '好友');
    await A.page.waitForFunction(() => !!document.querySelector('.friends-body'), { timeout: 10000 });
    await A.click('.tabs__tab', '并肩作战');
    await A.click('.friend-row .btn', '加好友');
    const arrived = await until(async () => {
      const [x, y] = [await slice(A), await slice(B)];
      return y.incoming.includes('Amiya') && x.outgoing.includes('Kaltsit') ? { x, y } : null;
    });
    check('B: the friend request arrived (push)', !!arrived && arrived.y.incoming.includes('Amiya'), JSON.stringify((await slice(B)).incoming));
    check('A: the request is pending in 已发送', !!arrived && arrived.x.outgoing.includes('Kaltsit'), JSON.stringify((await slice(A)).outgoing));
    await A.click('.modal .btn', '关闭');
    await B.page.evaluate(() => document.querySelector('.acc-row')?.scrollIntoView({ block: 'center' }));
    await B.click('.acc-row .btn', '好友');
    await B.page.waitForFunction(() => !!document.querySelector('.friends-body'), { timeout: 10000 });
    await B.click('.tabs__tab', '申请');
    await B.click('.friend-row .btn', '接受');
    const both = await until(async () => {
      const [x, y] = [await slice(A), await slice(B)];
      return x.friends.some((f) => f.startsWith('Kaltsit')) && y.friends.some((f) => f.startsWith('Amiya')) ? { x, y } : null;
    });
    check('A: B is a friend now (push)', !!both, JSON.stringify((await slice(A)).friends));
    check('B: A is a friend now (push)', !!both, JSON.stringify((await slice(B)).friends));
    await B.click('.modal .btn', '关闭');

    // 2b. a reload must log back in all by itself (the cached key rides `hello.key`, DESIGN §27.10) and the title
    // screen must be a full citizen: account bound, friends list live, call-sign prefilled — with no click at all
    await A.page.reload({ waitUntil: 'domcontentloaded' });
    await A.page.waitForFunction(() => !!globalThis.__SP__ && !!document.querySelector('.screen'), { timeout: 30000 });
    const reloaded = await until(async () => {
      const s = await slice(A);
      return s.accountId && s.friends.some((f) => f.startsWith('Kaltsit')) ? s : null;
    }, 20000);
    check('A: reload re-bound the cached key without typing anything', !!reloaded && reloaded.accountId === ids.A, JSON.stringify(reloaded));
    check('A: the title screen shows the friends list after the reload', !!reloaded && reloaded.friends.length === 1, JSON.stringify(reloaded ? reloaded.friends : null));
    check('A: the call-sign is prefilled after the reload', (await A.page.$eval('input', (el) => el.value)) === 'Amiya', '');

    // 3. A opens a coop room that friends may see, and B must see it in the friend list (with 加入)
    await enterLobby(A);
    check('A: the lobby has the friends button', await A.exists('.lobby-friends'));
    if (await A.page.$eval('.create-hidden input[type=checkbox]', (el) => el.checked)) await A.page.click('.create-hidden input[type=checkbox]');
    await A.click('.create-box .btn', '创建同盟');
    await A.page.waitForFunction(() => !!document.querySelector('.room-screen'), { timeout: 25000 });
    const roomA = (await slice(A)).room;
    check('A: the coop room was created', !!roomA && roomA.mode === 'coop', JSON.stringify(roomA));
    await enterLobby(B);
    const seen = await until(async () => (await slice(B)).friends.find((f) => f.includes(roomA.code) && f.endsWith('/join')));
    check('B: the friend list shows A waiting in the room', !!seen, JSON.stringify({ seen: seen || null, code: roomA.code }));

    // 4. the quick invite: A invites from the room chrome, the popup appears on B, B accepts into the same room
    await A.click('.btn', '邀请好友');
    await A.page.waitForFunction(() => !!document.querySelector('.friends-body'), { timeout: 10000 });
    await A.click('.tabs__tab', '好友');
    await A.click('.friend-row .btn', '邀请');
    const invited = await until(async () => (await slice(B)).invites.find((i) => i.startsWith('Amiya')));
    check('B: the invite arrived', !!invited, JSON.stringify((await slice(B)).invites));
    const popup = await until(() => B.page.evaluate(() => document.querySelector('.invite-pop')?.innerText.replace(/\s+/g, ' ') || null));
    check('B: the invite POPUP is shown', !!popup && popup.includes('Amiya'), String(popup || '').slice(0, 80));
    check('B: the popup names the room, mode, difficulty and size', !!popup && popup.includes(roomA.code) && popup.includes('同盟模拟') && popup.includes('DOCTORS'), String(popup || '').slice(0, 120));
    await B.click('.modal .btn', '接受');
    const joined = await until(async () => {
      const r = (await slice(B)).room;
      return r && r.code === roomA.code ? r : null;
    });
    check('B: accepting the invite joined the same room', !!joined, JSON.stringify(joined));
    const seats = await until(async () => {
      const [x, y] = [(await slice(A)).room, (await slice(B)).room];
      return x && y && x.seats.length === 2 && y.seats.length === 2 ? { x, y } : null;
    });
    check('both: the room seats two doctors', !!seats, JSON.stringify({ A: (await slice(A)).room, B: (await slice(B)).room }));
    check('A: the guest is visible in the seats', !!seats && seats.x.seats.includes('Kaltsit'), JSON.stringify(seats ? seats.x.seats : null));
  } catch (e) {
    check('no exception', false, e && e.message);
  } finally {
    failed = results.some((r) => r.startsWith('FAIL'));
    if (failed) { await A.shot('social-a').catch(() => {}); await B.shot('social-b').catch(() => {}); }
    await A.close(); await B.close(); await srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // Art is not tracked in this checkout: its 404s are not this feature's failures.
  const art = (p) => /\.(png|jpe?g|webp|mp3|ogg|wav|m4a|json|atlas|skel|ttf|woff2?)(\?|$)/.test(p) || /\/(assets|fonts|media)\//.test(p);
  const problems = problemsOf([A, B]).filter((p) => !art(p));
  for (const r of results) console.log(r);
  console.log(`\nnon-asset console/network problems: ${problems.length}`);
  for (const p of problems.slice(0, 15)) console.log('  ', p);
  return failed || problems.length > 0;
}

let puppeteer = null;
async function pptr() {
  if (!puppeteer) puppeteer = (await import('puppeteer-core')).default;
  return puppeteer;
}

if (!ENABLED) {
  console.log(`social.e2e: skipped (${hasChrome() ? 'inside the test runner — set SP_E2E=1' : `no Chrome at ${ROOT}/… (set CHROME_PATH)`})`);
  process.exit(0);
}
process.exitCode = (await main()) ? 1 : 0;
