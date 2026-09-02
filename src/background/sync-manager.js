// Sync orchestration, kept out of the service worker's main file.
//
// The rule this module exists to enforce: nothing leaves the machine except the
// encrypted blob, and nothing arrives without first proving it opens with the key
// already in memory. Sync therefore only runs while the vault is unlocked -- a
// blob that cannot be verified is never written over a working vault.

import { KEYS, local } from '../lib/storage.js';
import * as sync from '../lib/sync.js';

// Set by the service worker: the only ways this module can touch the vault.
let hooks = {
  readBlob: async () => null,
  applyRemoteBlob: async () => {},
  adoptBlob: async () => {},
  isUnlocked: async () => false,
  broadcast: () => {},
};

const DEBOUNCE_MS = 4000;

let debounceTimer = null;
let running = null;

export function configure(next) {
  hooks = { ...hooks, ...next };
}

// -------------------------------------------------------------------- storage

export function getConfig() {
  return local.get(KEYS.SYNC_CONFIG, null);
}

async function getSession() {
  return local.get(KEYS.SYNC_SESSION, null);
}

const EMPTY_STATE = Object.freeze({
  dirty: false,
  lastSyncedAt: '',
  lastError: '',
});

async function getState() {
  return { ...EMPTY_STATE, ...((await local.get(KEYS.SYNC_STATE, null)) || {}) };
}

async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await local.set(KEYS.SYNC_STATE, next);
  return next;
}

function deviceName() {
  const agent = navigator.userAgent || '';
  const platform = /Windows/.test(agent)
    ? 'Windows'
    : /Mac OS X/.test(agent)
      ? 'Mac'
      : /Linux/.test(agent)
        ? 'Linux'
        : 'This device';
  const browser = /Edg\//.test(agent) ? 'Edge' : /Brave/.test(agent) ? 'Brave' : 'Chrome';
  return `${platform} (${browser})`;
}

// ------------------------------------------------------------------- sessions

// Firebase ID tokens last an hour. Refresh rather than making the user sign in.
async function activeSession() {
  const config = await getConfig();
  if (!sync.isConfigured(config)) throw new Error('Sync is not set up yet.');
  const stored = await getSession();
  if (!stored) throw new Error('Sign in to sync first.');
  if (stored.expiresAt > Date.now()) return { config, session: stored };

  const refreshed = await sync.refreshSession(config, stored.refreshToken);
  const merged = { ...stored, ...refreshed };
  await local.set(KEYS.SYNC_SESSION, merged);
  return { config, session: merged };
}

export async function saveConfig(config) {
  const cleaned = {
    apiKey: String(config?.apiKey || '').trim(),
    projectId: String(config?.projectId || '').trim(),
    deviceName: String(config?.deviceName || '').trim() || deviceName(),
  };
  if (!sync.isConfigured(cleaned)) throw new Error('Both the API key and the project ID are needed.');

  const previous = await getConfig();
  await local.set(KEYS.SYNC_CONFIG, cleaned);
  // Pointing at a different project means the old sync state means nothing.
  if (previous && previous.projectId !== cleaned.projectId) {
    await local.remove(KEYS.SYNC_SESSION);
    await local.set(KEYS.SYNC_STATE, { ...EMPTY_STATE });
  }
  return { ok: true };
}

export async function signIn(email, password, { register = false } = {}) {
  const config = await getConfig();
  if (!sync.isConfigured(config)) throw new Error('Add the Firebase project details first.');

  const session = register
    ? await sync.signUp(config, email, password)
    : await sync.signIn(config, email, password);
  const previous = await getSession();

  await local.set(KEYS.SYNC_SESSION, session);
  // A different account owns a different document, so nothing about the old one
  // carries over. Deliberately not marked as needing an upload: on a second
  // computer that would send its empty vault over the real one.
  if (!previous || previous.uid !== session.uid) {
    await local.set(KEYS.SYNC_STATE, { ...EMPTY_STATE });
  }
  return { ok: true, email: session.email };
}

export async function signOut() {
  await local.remove(KEYS.SYNC_SESSION);
  await setState({ lastError: '' });
  return { ok: true };
}

export async function status() {
  const config = await getConfig();
  const session = await getSession();
  const state = await getState();
  return {
    configured: sync.isConfigured(config),
    config: config ? { ...config, apiKey: config.apiKey } : null,
    signedIn: Boolean(session),
    email: session?.email || '',
    deviceName: config?.deviceName || deviceName(),
    ...state,
  };
}

// ---------------------------------------------------------------- the exchange

// A save uploads itself a few seconds later, over whatever is on the server.
// Downloads stay manual, because an automatic one could replace what was just
// typed.
export async function markDirty() {
  const session = await getSession();
  if (!session) return;
  await setState({ dirty: true });
  scheduleUpload();
}

function scheduleUpload() {
  clearTimeout(debounceTimer);
  // Batch a burst of edits into one upload; the worker usually outlives this,
  // and if it does not, the dirty flag survives and the next check still sends it.
  debounceTimer = setTimeout(() => {
    syncNow({ pushOnly: true }).catch(() => {});
  }, DEBOUNCE_MS);
}

// Called before every edit: the change is applied on top of the server's copy
// rather than on top of whatever this computer last saw. That is what stops one
// machine's save erasing items the other added while it was not looking.
//
// It is best-effort by design. Offline, signed out, or a vault sealed under a
// different master password all mean the edit still saves locally -- refusing to
// save a password because a server could not be reached would be far worse.
export async function refreshBeforeEdit() {
  const session = await getSession();
  if (!session) return { skipped: true };
  if (!(await hooks.isUnlocked())) return { skipped: true };

  // Something here never made it up. Taking the server's copy now would throw it
  // away, so leave the local vault alone and let the upload carry it.
  const state = await getState();
  if (state.dirty) return { skipped: true };

  try {
    const { config, session: live } = await activeSession();
    const remote = await sync.fetchRemote(config, live);
    if (!remote) return { skipped: true };
    await hooks.applyRemoteBlob(remote.blob);
    await setState({ lastError: '', lastSyncedAt: new Date().toISOString() });
    hooks.broadcast({ type: 'sync:changed' });
    return { pulled: true };
  } catch (error) {
    await setState({ lastError: error.message });
    hooks.broadcast({ type: 'sync:changed' });
    return { failed: true, message: error.message };
  }
}

// One at a time. Two overlapping runs could push a stale blob over a fresh one.
export function syncNow(options = {}) {
  if (running) return running;
  running = runSync(options).finally(() => {
    running = null;
  });
  return running;
}

async function runSync({ pushOnly = false } = {}) {
  const { config, session } = await activeSession();
  if (!(await hooks.isUnlocked())) {
    throw new Error('Unlock the vault before syncing.');
  }

  try {
    const remote = await sync.fetchRemote(config, session);

    // Two moves, no bookkeeping between them. A save uploads, always, over
    // whatever is there -- so nothing you type is ever left behind. The button
    // downloads, always. The cost is that an upload replaces the whole document,
    // so take an update before editing if the other computer has been busy.
    const direction = pushOnly || !remote ? 'push' : 'pull';

    if (direction === 'pull') {
      // Refuses if the blob does not open with the key already in memory, so a
      // vault sealed under a different master password can never land silently.
      await hooks.applyRemoteBlob(remote.blob);
      await setState({ dirty: false, lastError: '', lastSyncedAt: new Date().toISOString() });
      // Distinct from state:changed: the whole vault was replaced, so any page
      // showing it has to start over rather than merge what it had.
      hooks.broadcast({ type: 'sync:pulled' });
      return { action: 'pull' };
    }

    const blob = await hooks.readBlob();
    if (!blob) throw new Error('There is no vault to upload yet.');
    await sync.pushRemote(config, session, {
      blob,
      updatedAt: new Date().toISOString(),
      device: config.deviceName || deviceName(),
    });
    await setState({ dirty: false, lastError: '', lastSyncedAt: new Date().toISOString() });
    hooks.broadcast({ type: 'sync:changed' });
    return { action: 'push' };
  } catch (error) {
    await setState({ lastError: error.message });
    hooks.broadcast({ type: 'sync:changed' });
    throw error;
  }
}

// Setting a second computer up.
//
// A vault created here has its own random salt, so the key held in memory cannot
// open a file sealed on another machine even when the master password is the
// same. Adopting asks for that password once and re-derives from the downloaded
// file's own parameters; from then on both machines share one file, one salt and
// one key, and ordinary syncing takes over.
export async function adoptRemote(password) {
  const { config, session } = await activeSession();
  const remote = await sync.fetchRemote(config, session);
  if (!remote) throw new Error('There is nothing on the server yet.');

  await hooks.adoptBlob(remote.blob, password);
  await setState({ dirty: false, lastError: '', lastSyncedAt: new Date().toISOString() });
  hooks.broadcast({ type: 'sync:pulled' });
  return { ok: true };
}
