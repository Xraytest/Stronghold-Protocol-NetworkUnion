// public/js/ui/friends.js — the browser UI of accounts, friends and quick invites (DESIGN §27).
//
// Wiring lives outside this file: main.js mounts <AccountHost/> once at the app root, screens/title.js renders
// <AccountRow/> in its login block and screens/lobby.js / screens/room.js put <FriendsButton/> and an 邀请好友 button
// in their chrome. Everything here is presentation plus the request calls of public/js/account.js; the state itself
// lives in the `account` / `ui` store slices, and the server pushes keep those fresh.
//
// Three modal-ish surfaces come out of one always-mounted host: the key reveal (KeyDialog), the friends panel and the
// incoming-invite popup. The popup is deliberately a normal <Modal/>: it can appear while a match runs and uses the
// same focus / Escape handling as every other dialog in the app.
//
// Styles live in css/social.css. Texts go through t()/N_() (docs/I18N.md).

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import {
  html, Fragment, Button, Icon, MicroLabel, Modal, TextField, Tabs, AvatarFrame, confirmDialog, useTicker,
} from './components.js';
import { copyText } from './clipboard.js';
import { toast, toastError } from './toasts.js';
import { t, N_ } from '../../../shared/i18n.js';
import { ERR, NAME_MAX_LEN, DIFFICULTY_NAMES } from '../../../shared/constants.js';
import { account, displayKey } from '../account.js';
import { store, useStore, shallowEqual } from '../store.js';
import { net } from '../net.js';

// ---- small helpers ----------------------------------------------------------------------------

/** Status label of a friend (server `friend.status`); unknown values read as offline. */
const STATUS_TEXT = new Map([
  ['idle', N_('在线')],
  ['lobby', N_('等待加入')],
  ['match', N_('正在进行')],
  ['solo', N_('独立模拟中')],
  ['hidden', N_('忙碌（已屏蔽）')],
  ['offline', N_('离线')],
]);
const statusText = (status) => t(STATUS_TEXT.get(status) || STATUS_TEXT.get('offline'));

/** Room mode name of an invite / friend room. */
const modeName = (mode) => (mode === 'solo' ? t('独立模拟') : t('同盟模拟'));

/** Difficulty name, degrading to the raw value for a difficulty the data does not know. */
const difficultyName = (d) => (DIFFICULTY_NAMES[d] ? t(DIFFICULTY_NAMES[d]) : String(d || ''));

/** Seconds an invite stays valid (ceil, ≥ 0) from its `expiresAt` epoch ms. */
function remainingSeconds(expiresAt) {
  const ms = Number(expiresAt) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, Math.ceil(ms / 1000)) : 0;
}

/** Show a failed account request: the bad-key case has a friendlier line than ERR_TEXT. */
function reportError(err) {
  if (!err) return;
  if (err.code === ERR.ACCOUNT_BAD_KEY) { toast(t('密钥无效或不属于任何账号'), 'warn'); return; }
  // account.login() already warned for a malformed key and simply rejected with this marker
  if (err.message === 'BAD_KEY_FORMAT') return;
  toastError(err);
}

/** Forget one handled invite (a copy: the slice is replaced immutably). */
function dropInvite(inviteId) {
  const cur = store.get().account.invites;
  store.patch('account', { invites: cur.filter((i) => i && i.inviteId !== inviteId) });
}

/**
 * Accept / decline a received invite and drop it from the store either way. INVITE_GONE (it expired, was used, or the
 * room closed) also drops it — it can never be answered again.
 * @param {{inviteId:string}} inv @param {boolean} accept @returns {Promise<boolean>} handled?
 */
async function respondInvite(inv, accept) {
  try {
    if (accept) await account.acceptInvite(inv.inviteId);
    else await account.declineInvite(inv.inviteId);
  } catch (err) {
    if (err?.code === ERR.INVITE_GONE) {
      dropInvite(inv.inviteId);
      toast(t('邀请已失效：对方可能已经开始模拟'), 'warn');
    } else {
      reportError(err);
    }
    return false;
  }
  dropInvite(inv.inviteId);
  if (accept) account.setPanel(false);
  return true;
}

// ---- incoming invite popup --------------------------------------------------------------------

/** The newest unanswered invite, as a modal. Dismissing (Escape / backdrop) only hides it locally. */
function InvitePopup() {
  const invites = useStore((s) => s.account.invites);
  const room = useStore((s) => s.room);
  const [dismissed, setDismissed] = useState(null);
  const [busy, setBusy] = useState(null);
  useTicker(invites.length ? 1000 : 0);
  // Never pop for an invite into the room we are already in (the panel can still answer it), nor for one hidden by
  // Escape — a newer invite has a different id and shows again.
  const inv = invites.find((i) => i && i.inviteId !== dismissed && !(room && room.code === i.code)) || null;
  if (!inv) return null;
  const act = async (accept) => {
    if (busy) return;
    setBusy(accept ? 'accept' : 'decline');
    await respondInvite(inv, accept);
    setBusy(null);
  };
  return html`<${Modal} open=${true} tone="amber" micro="ALLIANCE INVITE" title=${t('收到同盟邀请')}
      onClose=${() => setDismissed(inv.inviteId)}
      actions=${html`
        <${Button} variant="secondary" loading=${busy === 'decline'} onClick=${() => act(false)}>${t('拒绝')}<//>
        <${Button} variant="primary" icon="check" data-autofocus loading=${busy === 'accept'} onClick=${() => act(true)}>${t('接受')}<//>
      `}>
    <div class="invite-pop">
      <p class="invite-pop__from">${t('{name} 邀请你加入同盟', { name: inv.fromName || t('博士') })}</p>
      <div class="invite-pop__facts">
        <span><${MicroLabel}>ALLIANCE KEY<//><b class="num">${inv.code}</b></span>
        <span><${MicroLabel}>MODE<//><b>${modeName(inv.mode)}</b></span>
        <span><${MicroLabel}>DIFFICULTY<//><b>${difficultyName(inv.difficulty)}</b></span>
        <span><${MicroLabel}>DOCTORS<//><b class="num">${inv.players}</b></span>
      </div>
      <p class="invite-pop__ttl">${t('剩余 {n} 秒', { n: remainingSeconds(inv.expiresAt) })}</p>
    </div>
  <//>`;
}

// ---- key dialog --------------------------------------------------------------------------------

/** The account key, shown once on creation / rotation and on demand afterwards. */
export function KeyDialog() {
  const freshKey = useStore((s) => s.account.keyFresh);
  const logged = useStore((s) => !!s.account.accountId);
  const [busy, setBusy] = useState(null);
  const key = account.revealKey();
  const fresh = !!freshKey;
  const shown = key ? displayKey(key) : '';
  const copy = async () => {
    if (!key) return;
    const ok = await copyText(shown);
    if (ok) toast(t('已复制密钥'), 'success');
    else toast(t('复制失败，请手动复制'), 'warn');
  };
  const rotate = async () => {
    const ok = await confirmDialog({
      title: t('更换密钥'),
      text: t('更换密钥会立刻作废当前密钥：其他已经登录该账号的页面会全部断开，之后只有新密钥能登录。确定更换吗？'),
      okText: t('更换'), danger: true,
    });
    if (!ok) return;
    setBusy('rotate');
    try { await account.rotate(); } catch (err) { reportError(err); } finally { setBusy(null); }
  };
  return html`<${Modal} open=${true} tone=${fresh ? 'gold' : 'mint'} micro="ACCOUNT KEY" title=${t('账号密钥')}
      onClose=${() => account.setKeyDialog(false)}
      actions=${html`
        <${Button} variant=${fresh ? 'primary' : 'secondary'} icon="copy" data-autofocus=${fresh ? true : undefined} onClick=${copy}>${t('复制')}<//>
        ${logged ? html`<${Button} variant="ghost" icon="rotate" loading=${busy === 'rotate'} onClick=${rotate}>${t('更换密钥')}<//>` : null}
        <${Button} variant=${fresh ? 'secondary' : 'primary'} icon="check" onClick=${() => { account.clearFreshKey(); account.setKeyDialog(false); }}>${t('我已妥善保存')}<//>
      `}>
    <div class="keydlg">
      <div class="keydlg__key num selectable" aria-label=${t('账号密钥')}>${shown || t('（没有可显示的密钥）')}</div>
      <p class="keydlg__warn"><${Icon} name="warn" /><span>${t('这串密钥就是账号本身：没有用户名和密码，也无法找回。请把它保存在安全的地方——任何拿到它的人都能使用你的账号。')}</span></p>
    </div>
  <//>`;
}

// ---- account status row (title screen) ---------------------------------------------------------

/**
 * Account row for the title screen: create / log in while a guest, account name + actions once logged in.
 * @param {{ name?: string }} props the title screen's callsign, reused as the default name for 创建账号
 */
export function AccountRow({ name: initialName }) {
  const logged = useStore((s) => !!s.account.accountId);
  const accName = useStore((s) => s.account.name);
  const [callName, setCallName] = useState(initialName || '');
  const [keyText, setKeyText] = useState('');
  const [keyOpen, setKeyOpen] = useState(false);
  const [busy, setBusy] = useState(null);

  const create = async () => {
    if (busy) return;
    setBusy('create');
    try { await account.create(callName); } catch (err) { reportError(err); } finally { setBusy(null); }
  };
  const login = async () => {
    if (busy) return;
    setBusy('login');
    try { await account.login(keyText, callName); } catch (err) { reportError(err); } finally { setBusy(null); }
  };
  const logout = async () => {
    const ok = await confirmDialog({
      title: t('退出登录'),
      text: t('退出后本页不再使用该账号，但密钥不会被删除：你可以随时用同一串密钥重新登录。'),
      okText: t('退出'), danger: true,
    });
    if (ok && !busy) { setBusy('logout'); try { await account.logout(); } catch (err) { reportError(err); } finally { setBusy(null); } }
  };
  const rotate = async () => {
    const ok = await confirmDialog({
      title: t('更换密钥'),
      text: t('更换密钥会立刻作废当前密钥：其他已经登录该账号的页面会全部断开，之后只有新密钥能登录。确定更换吗？'),
      okText: t('更换'), danger: true,
    });
    if (ok && !busy) { setBusy('rotate'); try { await account.rotate(); } catch (err) { reportError(err); } finally { setBusy(null); } }
  };

  if (logged) {
    return html`<div class="acc-row acc-row--on brackets">
      <div class="acc-row__lead">
        <${Icon} name="user" />
        <div class="acc-row__text">
          <${MicroLabel}>ACCOUNT<//>
          <span class="acc-row__name">${accName || t('博士')}</span>
        </div>
      </div>
      <div class="acc-row__form">
        <${Button} size="md" icon="users" onClick=${() => account.setPanel(true)}>${t('好友')}<//>
        <${Button} size="md" icon="key" onClick=${() => account.setKeyDialog(true)}>${t('密钥')}<//>
        <${Button} size="md" variant="ghost" icon="exit" loading=${busy === 'logout'} onClick=${logout}>${t('退出登录')}<//>
        <${Button} size="md" variant="ghost" icon="rotate" loading=${busy === 'rotate'} onClick=${rotate}>${t('更换密钥')}<//>
      </div>
    </div>`;
  }
  return html`<div class="acc-row brackets">
    <div class="acc-row__lead">
      <${Icon} name="users" />
      <div class="acc-row__text">
        <${MicroLabel}>ACCOUNT<//>
        <span>${t('创建账号后即可添加好友、邀请他们并肩作战')}</span>
      </div>
    </div>
    <div class="acc-row__form">
      <${TextField} size="md" value=${callName} maxLength=${NAME_MAX_LEN} placeholder=${t('输入代号')}
        onInput=${setCallName} onEnter=${create} />
      <${Button} size="lg" icon="plus" loading=${busy === 'create'} disabled=${!callName.trim()} onClick=${create}>${t('创建账号')}<//>
      <${Button} size="lg" variant="ghost" icon="key" active=${keyOpen} onClick=${() => setKeyOpen((v) => !v)}>${t('已有密钥')}<//>
    </div>
    ${keyOpen ? html`<div class="acc-row__key">
      <${TextField} size="md" icon="key" value=${keyText} placeholder=${t('粘贴账号密钥')}
        onInput=${setKeyText} onEnter=${login} />
      <${Button} size="lg" variant="amber" icon="chevronRight" loading=${busy === 'login'}
        disabled=${!keyText.trim()} onClick=${login}>${t('登录')}<//>
    </div>` : null}
  </div>`;
}

// ---- friends button ----------------------------------------------------------------------------

/**
 * Compact friends entry (lobby / room chrome): the friend count and a badge for pending requests + invites.
 * @param {{ class?: string }} props
 */
export function FriendsButton({ class: cls }) {
  const friends = useStore((s) => s.account.friends.length);
  const pending = useStore((s) => s.account.incoming.length + s.account.invites.length);
  return html`<${Button} variant="secondary" size="lg" icon="users" class=${`friends-btn${cls ? ` ${cls}` : ''}`}
      onClick=${() => account.setPanel(true)} title=${t('好友')}>
    ${t('好友')}<span class="friends-btn__count num">${friends}</span>
    ${pending > 0 ? html`<span class="friends-btn__badge num">${pending}</span>` : null}
  <//>`;
}

// ---- friends panel -----------------------------------------------------------------------------

const PANEL_TABS = [
  { id: 'friends', label: N_('好友') },
  { id: 'requests', label: N_('申请') },
  { id: 'met', label: N_('并肩作战') },
  { id: 'invites', label: N_('邀请') },
];

/** The wide 好友 panel: friends / requests / met / invites, plus a refresh footer. */
export function FriendsPanel() {
  const acc = useStore((s) => s.account, shallowEqual);
  const room = useStore((s) => s.room);
  const [tab, setTab] = useState('friends');
  const [busy, setBusy] = useState(null);
  const alive = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => () => { alive.current = false; }, []);
  useTicker(acc.invites.length ? 1000 : 0);

  const run = async (kind, fn) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(kind);
    try { await fn(); } catch (err) { reportError(err); } finally {
      inFlight.current = false;
      if (alive.current) setBusy(null);
    }
  };
  const removeFriend = async (f) => {
    const ok = await confirmDialog({
      title: t('删除好友'),
      text: t('确定将「{name}」从好友中删除吗？你们可以再次互相添加。', { name: f.name || t('博士') }),
      okText: t('删除'), danger: true,
    });
    if (ok) run(`rm:${f.accountId}`, () => account.removeFriend(f.accountId));
  };

  const logged = !!acc.accountId;
  const sameRoom = (f) => !!(room && f.room && f.room.code === room.code);
  const canInvite = !!(room && room.mode === 'coop' && !room.inMatch);

  const friendsTab = !acc.friends.length
    ? html`<p class="friends-empty">${t('还没有好友。和朋友一起打完一局，就能在「并肩作战」里互相添加。')}</p>`
    : html`<div class="friend-list">${acc.friends.map((f) => html`<div key=${f.accountId} class="friend-row">
        <${AvatarFrame} size="sm" name=${f.name} seat=${0} offline=${f.status === 'offline'} />
        <div class="friend-row__who">
          <span class="friend-row__name">${f.name || t('博士')}</span>
          <span class=${`friend-row__status is-${f.status || 'offline'}`}>${statusText(f.status)}</span>
        </div>
        <div class="friend-row__acts">
          ${f.room?.joinable ? html`<${Button} size="sm" icon="users" loading=${busy === `join:${f.accountId}`}
            onClick=${() => run(`join:${f.accountId}`, async () => { await net.request('room.join', { code: f.room.code }); account.setPanel(false); })}>${t('加入')}<//>` : null}
          ${f.room?.spectatable ? html`<${Button} size="sm" icon="eye" loading=${busy === `spec:${f.accountId}`}
            onClick=${() => run(`spec:${f.accountId}`, async () => { await net.request('room.spectate', { code: f.room.code }); account.setPanel(false); })}>${t('观战')}<//>` : null}
          ${canInvite && !sameRoom(f) ? html`<${Button} size="sm" icon="link" loading=${busy === `inv:${f.accountId}`}
            onClick=${() => run(`inv:${f.accountId}`, async () => { await account.sendInvite(f.accountId); toast(t('邀请已发送'), 'success'); })}>${t('邀请')}<//>` : null}
          <${Button} size="sm" variant="ghost" onClick=${() => removeFriend(f)}>${t('删除好友')}<//>
        </div>
      </div>`)}</div>`;

  const requestsTab = html`<div class="friends-sec">
    <div class="friends-sec__head"><${MicroLabel}>INCOMING<//><span>${t('收到的申请')}</span></div>
    ${acc.incoming.length
      ? acc.incoming.map((r) => html`<div key=${r.accountId} class="friend-row">
          <${AvatarFrame} size="sm" name=${r.name} seat=${0} />
          <div class="friend-row__who"><span class="friend-row__name">${r.name || t('博士')}</span></div>
          <div class="friend-row__acts">
            <${Button} size="sm" variant="primary" icon="check" loading=${busy === `acc:${r.accountId}`}
              onClick=${() => run(`acc:${r.accountId}`, () => account.acceptFriend(r.accountId))}>${t('接受')}<//>
            <${Button} size="sm" loading=${busy === `dec:${r.accountId}`}
              onClick=${() => run(`dec:${r.accountId}`, () => account.declineFriend(r.accountId))}>${t('拒绝')}<//>
          </div>
        </div>`)
      : html`<p class="friends-empty">${t('没有待处理的申请。')}</p>`}
    <div class="friends-sec__head"><${MicroLabel}>OUTGOING<//><span>${t('已发送的申请')}</span></div>
    ${acc.outgoing.length
      ? acc.outgoing.map((r) => html`<div key=${r.accountId} class="friend-row">
          <${AvatarFrame} size="sm" name=${r.name} seat=${0} />
          <div class="friend-row__who"><span class="friend-row__name">${r.name || t('博士')}</span></div>
          <div class="friend-row__acts">
            <span class="friend-row__tag">${t('已发送')}</span>
            <${Button} size="sm" variant="ghost" loading=${busy === `cancel:${r.accountId}`}
              onClick=${() => run(`cancel:${r.accountId}`, () => account.declineFriend(r.accountId))}>${t('取消')}<//>
          </div>
        </div>`)
      : html`<p class="friends-empty">${t('没有已发送的申请。')}</p>`}
  </div>`;

  const metTab = !acc.met.length
    ? html`<p class="friends-empty">${t('还没有一起完成作战的博士。完成一局后，这里会出现可以添加的同伴。')}</p>`
    : html`<div class="friend-list">${acc.met.map((m) => {
        const isFriend = acc.friends.some((f) => f.accountId === m.accountId);
        const isPending = acc.outgoing.some((o) => o.accountId === m.accountId);
        return html`<div key=${m.accountId} class="friend-row">
          <${AvatarFrame} size="sm" name=${m.name} seat=${0} />
          <div class="friend-row__who"><span class="friend-row__name">${m.name || t('博士')}</span></div>
          <div class="friend-row__acts">
            ${isFriend ? html`<span class="friend-row__tag">${t('已是好友')}</span>`
              : isPending ? html`<span class="friend-row__tag">${t('已申请')}</span>`
              : html`<${Button} size="sm" icon="plus" loading=${busy === `add:${m.accountId}`}
                  onClick=${() => run(`add:${m.accountId}`, () => account.addFriend(m.accountId))}>${t('加好友')}<//>`}
          </div>
        </div>`;
      })}</div>`;

  const invitesTab = !acc.invites.length
    ? html`<p class="friends-empty">${t('没有待处理的邀请。')}</p>`
    : html`<div class="friend-list">${acc.invites.map((inv) => html`<div key=${inv.inviteId} class="friend-row">
        <${AvatarFrame} size="sm" name=${inv.fromName} seat=${0} />
        <div class="friend-row__who">
          <span class="friend-row__name">${inv.fromName || t('博士')}</span>
          <span class="friend-row__meta num">${inv.code} · ${difficultyName(inv.difficulty)} · ${t('剩余 {n} 秒', { n: remainingSeconds(inv.expiresAt) })}</span>
        </div>
        <div class="friend-row__acts">
          <${Button} size="sm" variant="primary" icon="check" loading=${busy === `iacc:${inv.inviteId}`}
            onClick=${() => run(`iacc:${inv.inviteId}`, () => respondInvite(inv, true))}>${t('接受')}<//>
          <${Button} size="sm" loading=${busy === `idec:${inv.inviteId}`}
            onClick=${() => run(`idec:${inv.inviteId}`, () => respondInvite(inv, false))}>${t('拒绝')}<//>
        </div>
      </div>`)}</div>`;

  const body = !logged
    ? html`<p class="friends-empty">${t('好友功能需要一个账号：请先在标题界面创建账号，或输入已有密钥登录。')}</p>`
    : tab === 'friends' ? friendsTab
    : tab === 'requests' ? requestsTab
    : tab === 'met' ? metTab
    : invitesTab;

  return html`<${Modal} open=${true} width="min(9.6rem, 92vw)" micro="SOCIAL LINK" title=${t('好友')}
      onClose=${() => account.setPanel(false)}
      actions=${html`
        <${Button} size="md" icon="refresh" loading=${busy === 'sync'} onClick=${() => run('sync', () => account.sync())}>${t('刷新')}<//>
        <${Button} size="md" variant="secondary" icon="close" onClick=${() => account.setPanel(false)}>${t('关闭')}<//>
      `}>
    <${Tabs} value=${tab} onChange=${setTab} items=${PANEL_TABS.map((x) => ({
      id: x.id, label: t(x.label),
      badge: x.id === 'requests' && acc.incoming.length ? acc.incoming.length
        : x.id === 'invites' && acc.invites.length ? acc.invites.length : null,
    }))} />
    <div class="friends-body">${body}</div>
  <//>`;
}

// ---- always-mounted host -----------------------------------------------------------------------

/** Host for the friends panel, the key dialog and the invite popup (mounted once by main.js). */
export function AccountHost() {
  const keyOpen = useStore((s) => s.ui.keyOpen);
  const friendsOpen = useStore((s) => s.ui.friendsOpen);
  return html`<${Fragment}>
    ${keyOpen ? html`<${KeyDialog} />` : null}
    ${friendsOpen ? html`<${FriendsPanel} />` : null}
    <${InvitePopup} />
  <//>`;
}
