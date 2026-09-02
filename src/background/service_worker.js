// The trusted core. Everything that touches the decrypted vault happens here.
//
// MV3 kills this worker after ~30 seconds of idle, which would drop the master
// key and force a re-unlock every time. The key therefore lives in
// chrome.storage.session with TRUSTED_CONTEXTS access: memory only, never written
// to disk, cleared when the browser closes, unreachable from any content script.

import * as vaultCrypto from '../lib/crypto.js';
import { KEYS, local, session, ensureSessionAccessLevel } from '../lib/storage.js';
import * as model from '../lib/vault.js';
import * as matcher from '../lib/matcher.js';
import { MSG } from '../lib/messages.js';
import { generatePassword, generatePassphrase } from '../lib/generator.js';
import { generateTotp, parseTotpInput } from '../lib/totp.js';
import { decodeImageData } from '../lib/qr.js';
import * as syncManager from './sync-manager.js';

const AUTOLOCK_ALARM = 'keyring:autolock';
const CLIPBOARD_ALARM = 'keyring:clipboard';
const OFFSCREEN_PATH = 'src/background/offscreen.html';

// Cached only for the lifetime of this worker. The blob on disk is the truth.
let cachedVault = null;
let cachedBlob = null;

// ---------------------------------------------------------------- vault access

async function getBlob() {
  if (!cachedBlob) cachedBlob = await local.get(KEYS.BLOB, null);
  return cachedBlob;
}

async function getRawKey() {
  const encoded = await session.get(KEYS.SESSION_KEY, null);
  return encoded ? vaultCrypto.fromBase64(encoded) : null;
}

async function isLocked() {
  return (await getRawKey()) === null;
}

async function getVault() {
  if (cachedVault) return cachedVault;
  const rawKey = await getRawKey();
  if (!rawKey) return null;
  const blob = await getBlob();
  if (!blob) return null;
  cachedVault = model.migrate(await vaultCrypto.open(blob, rawKey));
  return cachedVault;
}

// quiet: written to disk but not queued for upload. Used for lastUsedAt, which
// is ordering metadata -- worth keeping, not worth a round trip, and not worth
// the risk of sending a stale vault over a fresher one.
async function persist(vault, { quiet = false } = {}) {
  const rawKey = await getRawKey();
  if (!rawKey) throw new Error('Vault is locked.');
  const blob = await getBlob();
  const sealed = await vaultCrypto.reseal(vault, rawKey, blob);
  await local.set(KEYS.BLOB, sealed);
  cachedBlob = sealed;
  cachedVault = vault;
  if (!quiet) syncManager.markDirty().catch(() => {});
  return vault;
}

// Every real edit goes through here: take the server's copy first, apply the
// change to that, then let persist queue the upload. An edit therefore lands on
// top of what the other computer published instead of replacing it.
async function editVault(apply) {
  await syncManager.refreshBeforeEdit();
  const vault = await requireVault();
  const next = await apply(vault);
  await persist(next);
  await refreshBadgeForActiveTab();
  broadcast({ type: 'state:changed' });
  return next;
}

async function requireVault() {
  const vault = await getVault();
  if (!vault) throw new Error('Vault is locked.');
  return vault;
}

// ------------------------------------------------------------------ lock state

async function lock() {
  cachedVault = null;
  await session.remove(KEYS.SESSION_KEY);
  await session.remove(KEYS.UNLOCK_EXPIRES);
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await refreshBadgeForActiveTab();
  broadcast({ type: 'state:locked' });
}

async function touch() {
  // After the worker restarts, cachedVault is empty but the vault may still be
  // unlocked -- read it back so the user's own timeout is honoured, not the default.
  const vault = cachedVault || (await getVault());
  const minutes = vault?.settings?.autoLockMinutes ?? model.defaultSettings().autoLockMinutes;
  if (!minutes || minutes <= 0) {
    await session.remove(KEYS.UNLOCK_EXPIRES);
    await chrome.alarms.clear(AUTOLOCK_ALARM);
    return;
  }
  await session.set(KEYS.UNLOCK_EXPIRES, Date.now() + minutes * 60_000);
  await chrome.alarms.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
}

async function checkAutoLock() {
  if (await isLocked()) return;
  const expires = await session.get(KEYS.UNLOCK_EXPIRES, 0);
  if (expires && Date.now() >= expires) await lock();
}

// --------------------------------------------------------------------- actions

async function createVault(password) {
  if (await getBlob()) throw new Error('A vault already exists on this profile.');
  const fresh = model.emptyVault();
  const { blob, rawKey } = await vaultCrypto.create(fresh, password);
  await local.set(KEYS.BLOB, blob);
  cachedBlob = blob;
  cachedVault = fresh;
  await session.set(KEYS.SESSION_KEY, vaultCrypto.toBase64(rawKey));
  await touch();
  await refreshBadgeForActiveTab();
  syncManager.markDirty().catch(() => {});
  return { ok: true };
}

async function unlockVault(password) {
  const blob = await getBlob();
  if (!blob) throw new Error('No vault on this profile yet.');
  const { vault, rawKey } = await vaultCrypto.unlock(blob, password);
  cachedVault = model.migrate(vault);
  await session.set(KEYS.SESSION_KEY, vaultCrypto.toBase64(rawKey));
  await touch();
  await refreshBadgeForActiveTab();
  broadcast({ type: 'state:unlocked' });
  return { ok: true };
}

async function changeMasterPassword(currentPassword, nextPassword) {
  const blob = await getBlob();
  if (!blob) throw new Error('No vault on this profile yet.');
  const { vault } = await vaultCrypto.unlock(blob, currentPassword);
  const { blob: nextBlob, rawKey } = await vaultCrypto.create(model.migrate(vault), nextPassword);
  await local.set(KEYS.BLOB, nextBlob);
  cachedBlob = nextBlob;
  cachedVault = model.migrate(vault);
  await session.set(KEYS.SESSION_KEY, vaultCrypto.toBase64(rawKey));
  await touch();
  syncManager.markDirty().catch(() => {});
  return { ok: true };
}

// Import replaces the whole vault from an exported blob, so it doubles as restore
// and as the first download of a synced vault.
async function importBlob(blob, password, { fromSync = false } = {}) {
  vaultCrypto.assertBlob(blob);
  const { vault, rawKey } = await vaultCrypto.unlock(blob, password);
  await local.set(KEYS.BLOB, blob);
  cachedBlob = blob;
  cachedVault = model.migrate(vault);
  await session.set(KEYS.SESSION_KEY, vaultCrypto.toBase64(rawKey));
  await touch();
  // A vault that just came down from the server is not a change to send back up.
  if (!fromSync) syncManager.markDirty().catch(() => {});
  return { ok: true, itemCount: cachedVault.items.length };
}

async function wipeEverything() {
  cachedVault = null;
  cachedBlob = null;
  await session.clear();
  await local.clear();
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await refreshBadgeForActiveTab();
  return { ok: true };
}

// ------------------------------------------------------------------- autofill

// Content scripts only ever learn that a match exists and what it is called.
async function matchesFor(pageUrl) {
  if (await isLocked()) return { locked: true, items: [] };
  const vault = await requireVault();
  const domain = matcher.registrableDomain(pageUrl);
  if (domain && (vault.settings.neverDomains || []).includes(domain)) {
    return { locked: false, items: [], never: true };
  }
  const ranked = matcher.rankMatches(vault.items, pageUrl);
  return {
    locked: false,
    showIcon: vault.settings.showInlineIcon !== false,
    items: ranked.map(model.publicSummary),
  };
}

// Secrets leave here for exactly one item, and only after the item is confirmed
// to match the URL of the frame that asked.
async function credentialFor(itemId, frameUrl) {
  const vault = await requireVault();
  const item = model.getItem(vault, itemId);
  if (!item) throw new Error('That item no longer exists.');
  if (!matcher.itemMatches(item, frameUrl)) {
    throw new Error('That item is not saved for this site.');
  }

  const page = matcher.parseUrl(frameUrl);
  const localOnly = page && matcher.isLocalHost(page.hostname);
  if (page && page.protocol === 'http:' && !localOnly && !item.allowInsecure) {
    const error = new Error('This page is not encrypted (http). Enable "allow on insecure pages" for this item to fill it here.');
    error.code = 'insecure';
    throw error;
  }

  await persist(model.touchItem(vault, itemId), { quiet: true });

  let totpCode = '';
  if (item.totp) {
    try {
      totpCode = await generateTotp(model.totpConfig(item));
    } catch {
      totpCode = '';
    }
  }
  // A standalone code entry has no username or password; the content script fills
  // only the fields it gets a value for.
  return { username: item.username || '', password: item.password || '', totp: totpCode };
}

// ------------------------------------------------------------------- capture

// Two-screen logins type the username on one page and the password on the next,
// so the username is remembered per tab until the password shows up.
async function rememberUsername(tabId, username) {
  if (typeof tabId !== 'number' || !username) return { ok: false };
  const remembered = (await session.get(KEYS.LAST_USERNAME, {})) || {};
  remembered[tabId] = { username, at: Date.now() };
  await session.set(KEYS.LAST_USERNAME, remembered);
  return { ok: true };
}

async function recallUsername(tabId) {
  if (typeof tabId !== 'number') return '';
  const remembered = (await session.get(KEYS.LAST_USERNAME, {})) || {};
  const entry = remembered[tabId];
  if (!entry) return '';
  return Date.now() - entry.at < 10 * 60_000 ? entry.username : '';
}

async function offerCapture(payload, tab) {
  const vault = await getVault();
  const url = payload.url || tab?.url;
  const domain = matcher.registrableDomain(url);
  if (!payload.username) {
    payload = { ...payload, username: await recallUsername(tab?.id) };
  }

  if (!vault) {
    // Locked: hold it so the popup can offer to save it after the next unlock.
    await session.set(KEYS.PENDING_CAPTURE, { ...payload, url, at: Date.now() });
    return { action: 'pending' };
  }

  if (!vault.settings.offerToSave) return { action: 'none' };
  if (domain && (vault.settings.neverDomains || []).includes(domain)) {
    return { action: 'none' };
  }

  const decision = decideCapture(vault, payload, url);
  if (decision.action === 'none') return decision;

  await session.set(KEYS.PENDING_CAPTURE, { ...payload, url, at: Date.now() });
  if (tab) {
    chrome.tabs
      .sendMessage(tab.id, {
        type: MSG.CAPTURE_PROMPT,
        action: decision.action,
        itemId: decision.itemId || '',
        itemName: decision.itemName || '',
        username: payload.username || '',
        domain: domain || '',
      })
      .catch(() => {});
  }
  return decision;
}

function decideCapture(vault, payload, url) {
  const password = payload.password || '';
  const username = (payload.username || '').trim();
  if (!password) return { action: 'none' };

  const candidates = matcher
    .rankMatches(vault.items, url)
    .filter((item) => item.type === 'login');
  const sameUser = candidates.find(
    (item) => (item.username || '').toLowerCase() === username.toLowerCase(),
  );

  if (sameUser) {
    if (sameUser.password === password) return { action: 'none' };
    return { action: 'update', itemId: sameUser.id, itemName: sameUser.name };
  }

  // No username captured but exactly one credential saved here: treat a changed
  // password as an update to it rather than a stray new entry.
  if (!username && candidates.length === 1) {
    if (candidates[0].password === password) return { action: 'none' };
    return { action: 'update', itemId: candidates[0].id, itemName: candidates[0].name };
  }

  return { action: 'new' };
}

// The password comes from the pending capture held in session storage, never
// from the caller, so it does not make a round trip through the web page.
async function saveCapture({ action, itemId, name }) {
  await requireVault();
  const pending = await session.get(KEYS.PENDING_CAPTURE, null);
  if (!pending || !pending.password) throw new Error('There is nothing waiting to be saved.');
  const { username, password, url } = pending;

  await editVault((current) => {
    if (action === 'update' && itemId) {
      const existing = model.getItem(current, itemId);
      if (!existing) throw new Error('That item no longer exists.');
      const updated = { ...existing, password };
      if (username && !existing.username) updated.username = username;
      return model.upsertItem(current, updated);
    }
    const item = model.newItem('login', {
      name: name || matcher.suggestedName(url),
      username: username || '',
      password,
      uris: url ? [{ uri: matcher.parseUrl(url)?.origin || url, matchType: 'domain' }] : [],
    });
    return model.upsertItem(current, item);
  });

  await session.remove(KEYS.PENDING_CAPTURE);
  return { ok: true };
}

async function neverForDomain(url) {
  await requireVault();
  const domain = matcher.registrableDomain(url);
  if (!domain) return { ok: false };
  await editVault((current) => ({
    ...current,
    settings: {
      ...current.settings,
      neverDomains: [...new Set([...(current.settings.neverDomains || []), domain])],
    },
  }));
  await session.remove(KEYS.PENDING_CAPTURE);
  return { ok: true, domain };
}

// ------------------------------------------------------------------ qr codes

// The popup asks for a scan and then closes, because clicking into the page to
// choose the region dismisses it. So the whole job finishes here: ask the page for
// a region, capture, decode, save, and report back on the page itself.
async function resolveScanTab(preferredTabId) {
  if (typeof preferredTabId === 'number') {
    try {
      const tab = await chrome.tabs.get(preferredTabId);
      if (tab && /^https?:/.test(tab.url || '')) return tab;
    } catch {
      // Closed since the popup opened.
    }
  }
  // lastFocusedWindow can point at a popup or devtools window, so fall back to
  // ordinary browser windows.
  const candidates = await chrome.tabs.query({ active: true, windowType: 'normal' });
  const tab = candidates.find((entry) => /^https?:/.test(entry.url || ''));
  if (!tab) throw new Error('Open the page showing the QR code first.');
  return tab;
}

async function toastOnTab(tabId, text) {
  chrome.tabs.sendMessage(tabId, { type: 'ui:toast', text }, { frameId: 0 }).catch(() => {});
}

async function scanTabRegion(preferredTabId) {
  const tab = await resolveScanTab(preferredTabId);

  let region = null;
  try {
    // frameId 0 is the main frame. Without it the message goes to every frame in
    // the tab and the first reply wins -- which is an iframe saying "not me",
    // arriving long before the top frame has finished waiting for the drag.
    region = await chrome.tabs.sendMessage(
      tab.id,
      { type: 'qr:selectRegion' },
      { frameId: 0 },
    );
  } catch {
    throw new Error('Reload the page and try again — Keyring is not running on it yet.');
  }
  if (!region || region.cancelled) return { cancelled: true };
  if (!region.rect) throw new Error('The selection did not come back. Try the scan again.');

  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch {
    const message = 'This page cannot be captured. Save the QR code as an image and import it instead.';
    await toastOnTab(tab.id, message);
    throw new Error(message);
  }

  try {
    const text = decodeRegion(await fetch(dataUrl), region);
    const saved = await saveScannedCode(await text);
    await toastOnTab(tab.id, saved.message);
    broadcast({ type: 'state:changed' });
    return saved;
  } catch (error) {
    await toastOnTab(tab.id, error.message);
    throw error;
  }
}

// Crop the screenshot to the chosen region before decoding. The capture is in
// device pixels; the region came back in CSS pixels.
async function decodeRegion(response, region) {
  const bitmap = await createImageBitmap(await response.blob());
  const ratio = region.devicePixelRatio || 1;
  const rect = region.rect;

  const left = Math.max(0, Math.floor(rect.left * ratio));
  const top = Math.max(0, Math.floor(rect.top * ratio));
  const width = Math.min(bitmap.width - left, Math.ceil(rect.width * ratio));
  const height = Math.min(bitmap.height - top, Math.ceil(rect.height * ratio));
  if (width < 8 || height < 8) {
    bitmap.close();
    throw new Error('That selection is too small to hold a QR code.');
  }

  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, left, top, width, height, 0, 0, width, height);
  const imageData = context.getImageData(0, 0, width, height);
  bitmap.close();

  return decodeImageData(imageData);
}

async function saveScannedCode(text) {
  const parsed = parseTotpInput(text);
  if (!parsed || !parsed.secret) {
    throw new Error('That QR code is not an authenticator code.');
  }

  const vault = await requireVault();
  const already = vault.items.find(
    (item) => (item.totp || '').toUpperCase() === parsed.secret.toUpperCase(),
  );
  if (already) {
    return { ok: true, duplicate: true, message: `That code is already saved as "${already.name}".` };
  }

  const item = model.newItem('totp', {
    name: parsed.issuer || parsed.account || 'Authenticator code',
    username: parsed.account || '',
    totp: parsed.secret,
    totpAlgorithm: parsed.algorithm,
    totpDigits: parsed.digits,
    totpPeriod: parsed.period,
  });
  await editVault((current) => model.upsertItem(current, item));
  return { ok: true, name: item.name, message: `Keyring saved the code for ${item.name}.` };
}

// ------------------------------------------------------------------ clipboard

// chrome.alarms will not fire sooner than 30 seconds, so anything shorter is
// rounded up rather than silently ignored.
async function scheduleClipboardClear(seconds) {
  const delay = Math.max(30, Number(seconds) || 30);
  await chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: delay / 60 });
  return { ok: true, seconds: delay };
}

async function clearClipboard() {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['CLIPBOARD'],
        justification: 'Clear a copied password from the clipboard.',
      });
    }
    await chrome.runtime.sendMessage({ type: 'clipboard:clear' });
  } catch {
    // Offscreen unavailable; the clipboard keeps its contents.
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      // Already gone.
    }
  }
}

// ---------------------------------------------------------------------- badge

async function refreshBadgeForActiveTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await refreshBadge(tab);
  } catch {
    // No window focused yet.
  }
}

async function refreshBadge(tab) {
  const tabId = tab?.id;
  if (typeof tabId !== 'number') return;

  const setBadge = async (text, color) => {
    try {
      await chrome.action.setBadgeText({ tabId, text });
      if (text) await chrome.action.setBadgeBackgroundColor({ tabId, color });
    } catch {
      // Tab closed mid-flight.
    }
  };

  if (await isLocked()) return setBadge('', '#000000');
  if (!tab.url || !/^https?:/.test(tab.url)) return setBadge('', '#000000');

  const { items } = await matchesFor(tab.url);
  await setBadge(items.length ? String(items.length) : '', '#2f6f4f');
}

// ------------------------------------------------------------------ messaging

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
}

// Content scripts are hostile-adjacent: they run in pages we do not control, so
// they get a strict allowlist and never see the vault.
const CONTENT_ALLOWED = new Set([
  MSG.MATCHES,
  MSG.CREDENTIAL,
  MSG.CAPTURE_OFFER,
  MSG.CAPTURE_SAVE,
  MSG.CAPTURE_NEVER,
  MSG.CAPTURE_DISCARD,
  MSG.OPEN_POPUP,
  'capture:username',
  'gen:password',
]);

// sender.tab is set for our own pages too when they are open in a tab (the
// onboarding and options pages both are), so trust is decided by the sender's
// origin: only chrome-extension://<our id> counts as the trusted side.
function isExtensionPage(sender) {
  if (sender.id !== chrome.runtime.id) return false;
  const own = `chrome-extension://${chrome.runtime.id}`;
  if (sender.origin) return sender.origin === own;
  return String(sender.url || '').startsWith(own + '/');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtensionPage(sender)) {
    if (sender.id !== chrome.runtime.id) {
      sendResponse({ error: 'Not allowed.' });
      return false;
    }
    if (!CONTENT_ALLOWED.has(message?.type)) {
      sendResponse({ error: 'Not allowed from a web page.' });
      return false;
    }
  }

  handleMessage(message, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ error: error.message, code: error.code || '' }));
  return true; // async
});

async function handleMessage(message, sender) {
  const { type } = message || {};
  const frameUrl = sender.url || sender.tab?.url || '';

  switch (type) {
    case MSG.STATUS: {
      const blob = await getBlob();
      const locked = await isLocked();
      // The pending password stays in the worker; the popup only needs to know
      // that something is waiting and who it belongs to.
      const pending = locked ? null : await session.get(KEYS.PENDING_CAPTURE, null);
      return {
        initialized: Boolean(blob),
        locked,
        pendingCapture: pending ? { username: pending.username || '', url: pending.url } : null,
      };
    }

    case MSG.CREATE:
      return createVault(message.password);

    case MSG.UNLOCK:
      return unlockVault(message.password);

    case MSG.LOCK:
      await lock();
      return { ok: true };

    case MSG.TOUCH:
      await touch();
      return { ok: true };

    // Copying a password or a code counts as using the item, the same as
    // filling it does -- otherwise the recency order only ever reflects fills.
    case MSG.USED: {
      const vault = await requireVault();
      if (!model.getItem(vault, message.itemId)) return { ok: false };
      await persist(model.touchItem(vault, message.itemId), { quiet: true });
      return { ok: true };
    }

    case MSG.GET: {
      await touch();
      const vault = await requireVault();
      return { vault };
    }

    case MSG.ITEM_SAVE: {
      await touch();
      const vault = await editVault((current) => model.upsertItem(current, message.item));
      return { vault };
    }

    case MSG.ITEM_DELETE: {
      await touch();
      const vault = await editVault((current) => model.deleteItem(current, message.itemId));
      return { vault };
    }

    case MSG.ITEMS_ADD: {
      await touch();
      const vault = await editVault((current) =>
        (message.items || []).reduce((acc, item) => model.upsertItem(acc, item), current),
      );
      return { vault };
    }

    case MSG.CHANGE_PASSWORD:
      return changeMasterPassword(message.currentPassword, message.nextPassword);

    case MSG.EXPORT: {
      await requireVault();
      return { blob: await getBlob() };
    }

    case MSG.IMPORT_BLOB:
      return importBlob(message.blob, message.password);

    case MSG.WIPE:
      return wipeEverything();

    case MSG.MATCHES:
      return matchesFor(message.url || frameUrl);

    case MSG.CREDENTIAL: {
      await touch();
      return credentialFor(message.itemId, frameUrl || message.url);
    }

    case MSG.FILL_FROM_POPUP:
      return fillFromPopup(message.itemId, message.tabId);

    case MSG.TOTP_CODE: {
      await touch();
      const vault = await requireVault();
      const item = model.getItem(vault, message.itemId);
      if (!item || !item.totp) throw new Error('No authenticator secret on that item.');
      return { code: await generateTotp(model.totpConfig(item)) };
    }

    case MSG.SCAN_TAB:
      return scanTabRegion(message.tabId);

    case MSG.CAPTURE_OFFER:
      return offerCapture(message, sender.tab);

    case 'capture:username':
      return rememberUsername(sender.tab?.id, message.username);

    case MSG.CAPTURE_SAVE:
      return saveCapture(message);

    case MSG.CAPTURE_NEVER:
      return neverForDomain(message.url || frameUrl);

    case MSG.CAPTURE_DISCARD:
      await session.remove(KEYS.PENDING_CAPTURE);
      return { ok: true };

    case MSG.CAPTURE_PENDING:
      return { pending: await session.get(KEYS.PENDING_CAPTURE, null) };

    case MSG.OPEN_POPUP:
      await openPopup();
      return { ok: true };

    case MSG.SETTINGS_SET: {
      await touch();
      const vault = await editVault((current) => ({
        ...current,
        settings: { ...current.settings, ...message.settings },
      }));
      return { vault };
    }

    case MSG.SYNC_STATUS:
      return syncManager.status();

    case MSG.SYNC_CONFIGURE:
      return syncManager.saveConfig(message.config);

    case MSG.SYNC_SIGNIN:
      return syncManager.signIn(message.email, message.password, { register: false });

    case MSG.SYNC_SIGNUP:
      return syncManager.signIn(message.email, message.password, { register: true });

    case MSG.SYNC_SIGNOUT:
      return syncManager.signOut();

    case MSG.SYNC_NOW:
      return syncManager.syncNow();

    case MSG.SYNC_ADOPT:
      return syncManager.adoptRemote(message.password);

    case 'clipboard:scheduleClear':
      return scheduleClipboardClear(message.seconds);

    case 'gen:password':
      return {
        password: message.mode === 'passphrase'
          ? generatePassphrase(message.options)
          : generatePassword(message.options),
      };

    default:
      throw new Error('Unknown request: ' + type);
  }
}

async function openPopup() {
  try {
    await chrome.action.openPopup();
  } catch {
    await chrome.windows.create({
      url: chrome.runtime.getURL('src/popup/popup.html?standalone=1'),
      type: 'popup',
      width: 400,
      height: 620,
    });
  }
}

// Fill triggered from the popup: the popup knows the tab, the content script does
// the DOM work.
async function fillFromPopup(itemId, tabId) {
  const tab = tabId
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (!tab) throw new Error('No active tab.');

  const credential = await credentialFor(itemId, tab.url);
  await chrome.tabs.sendMessage(tab.id, { type: 'fill:apply', credential }).catch(() => {
    throw new Error('This page cannot be filled. Reload it and try again.');
  });
  return { ok: true };
}

// ------------------------------------------------------------------- lifecycle

chrome.runtime.onInstalled.addListener(async (details) => {
  await ensureSessionAccessLevel();
  buildContextMenus();
  if (details.reason === 'install' && !(await local.get(KEYS.BLOB, null))) {
    chrome.tabs.create({ url: chrome.runtime.getURL('src/onboarding/onboarding.html') });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureSessionAccessLevel();
  buildContextMenus();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) checkAutoLock();
  if (alarm.name === CLIPBOARD_ALARM) clearClipboard();
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    refreshBadge(await chrome.tabs.get(tabId));
  } catch {
    // Tab vanished.
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.url) refreshBadge(tab);
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'lock') return lock();
  if (command !== 'fill') return;
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) return;
  chrome.tabs.sendMessage(tab.id, { type: MSG.TRIGGER }).catch(() => {});
});

function buildContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'keyring:fill',
      title: 'Fill login',
      contexts: ['editable', 'page'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({
      id: 'keyring:generate',
      title: 'Generate password into this field',
      contexts: ['editable'],
      documentUrlPatterns: ['http://*/*', 'https://*/*'],
    });
    chrome.contextMenus.create({ id: 'keyring:sep', type: 'separator', contexts: ['all'] });
    chrome.contextMenus.create({ id: 'keyring:lock', title: 'Lock Keyring', contexts: ['all'] });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'keyring:lock') return lock();
  if (!tab?.id) return;
  if (info.menuItemId === 'keyring:fill') {
    chrome.tabs.sendMessage(tab.id, { type: MSG.TRIGGER }, { frameId: info.frameId }).catch(() => {});
  }
  if (info.menuItemId === 'keyring:generate') {
    chrome.tabs
      .sendMessage(tab.id, { type: 'fill:generate' }, { frameId: info.frameId })
      .catch(() => {});
  }
});

// --------------------------------------------------------------------- sync

// The only doors the sync module has into the vault. Note applyRemoteBlob: a
// downloaded blob has to open with the key already in memory before it is allowed
// to replace anything, so a vault sealed under a different master password is
// rejected instead of quietly locking the user out of their own machine.
syncManager.configure({
  readBlob: () => getBlob(),
  adoptBlob: (blob, password) => importBlob(blob, password, { fromSync: true }),
  isUnlocked: async () => !(await isLocked()),
  broadcast,
  async applyRemoteBlob(blob) {
    vaultCrypto.assertBlob(blob);
    const rawKey = await getRawKey();
    if (!rawKey) throw new Error('Vault is locked.');

    let vault;
    try {
      vault = await vaultCrypto.open(blob, rawKey);
    } catch {
      throw new Error(
        'The file on the server was sealed on another computer. Use "Open the synced vault" on the Sync page and enter its master password once.',
      );
    }

    await local.set(KEYS.BLOB, blob);
    cachedBlob = blob;
    cachedVault = model.migrate(vault);
    await refreshBadgeForActiveTab();
  },
});

// Kick the access level on every cold start of the worker.
ensureSessionAccessLevel();
