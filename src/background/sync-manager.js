// Sync orchestration, kept out of the service worker's main file.
//
// The rule this module exists to enforce: nothing leaves the machine except the
// encrypted blob, and nothing arrives without first proving it opens with the key
// already in memory. Sync therefore only runs while the vault is unlocked -- a
// blob that cannot be verified is never written over a working vault.

import { KEYS, local } from '../lib/storage.js';
import * as sync from '../lib/sync.js';

const SYNC_ALARM = 'keyring:sync';
const DEBOUNCE_MS = 4000;

// Set by the service worker: the only ways this module can touch the vault.
let hooks = {
  readBlob: async () => null,
  applyRemoteBlob: async () => {},
  adoptBlob: async () => {},
  isUnlocked: async () => false,
  broadcast: () => {},
};

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
  revision: 0,
  dirty: false,
  lastSyncedAt: '',
  lastError: '',
  conflict: null,
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
  // Pointing at a different project means the old revision number means nothing.
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
  // carries over. The local vault is left alone and is pushed or merged below.
  if (!previous || previous.uid !== session.uid) {
    await local.set(KEYS.SYNC_STATE, { ...EMPTY_STATE, dirty: true });
  }
  await ensureAlarm();
  return { ok: true, email: session.email };
}

export async function signOut() {
  await local.remove(KEYS.SYNC_SESSION);
  await setState({ conflict: null, lastError: '' });
  await chrome.alarms.clear(SYNC_ALARM);
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

export async function markDirty() {
  const session = await getSession();
  if (!session) return;
  await setState({ dirty: true });
  scheduleSync();
}

function scheduleSync() {
  clearTimeout(debounceTimer);
  // Batch a burst of edits into one upload; the worker usually outlives this.
  debounceTimer = setTimeout(() => {
    syncNow().catch(() => {});
  }, DEBOUNCE_MS);
  ensureAlarm();
}

// The alarm is the backstop: it catches anything the debounce missed because the
// worker was torn down, and it is what pulls in edits made on another machine.
async function ensureAlarm() {
  try {
    await chrome.alarms.create(SYNC_ALARM, { periodInMinutes: 5 });
  } catch {
    // Alarms unavailable; manual sync still works.
  }
}

export async function onAlarm() {
  const session = await getSession();
  if (!session) return;
  if (!(await hooks.isUnlocked())) return;
  await syncNow().catch(() => {});
}

// One at a time. Two overlapping runs would race on the revision counter and
// could push a stale blob over a fresh one.
export function syncNow(options = {}) {
  if (running) return running;
  running = runSync(options).finally(() => {
    running = null;
  });
  return running;
}

async function runSync({ resolve = '' } = {}) {
  const { config, session } = await activeSession();
  if (!(await hooks.isUnlocked())) {
    throw new Error('Unlock the vault before syncing.');
  }

  try {
    const state = await getState();
    const remote = await sync.fetchRemote(config, session);
    let action =
      resolve === 'local' ? 'push' : resolve === 'remote' ? 'pull' : sync.decideSync(state, remote);
    // "Take the server copy" when the server has nothing is just a first upload.
    if (action === 'pull' && !remote) action = 'push';

    if (action === 'conflict') {
      const conflict = {
        remoteRevision: remote.revision,
        remoteUpdatedAt: remote.updatedAt,
        remoteDevice: remote.device,
        localRevision: state.revision,
      };
      await setState({ conflict, lastError: '' });
      hooks.broadcast({ type: 'sync:changed' });
      return { action: 'conflict', conflict };
    }

    if (action === 'none') {
      await setState({ conflict: null, lastError: '', lastSyncedAt: new Date().toISOString() });
      hooks.broadcast({ type: 'sync:changed' });
      return { action: 'none' };
    }

    if (action === 'pull') {
      // Refuses if the blob does not open with the key already in memory, so a
      // vault sealed under a different master password can never land silently.
      await hooks.applyRemoteBlob(remote.blob);
      await setState({
        revision: remote.revision,
        dirty: false,
        conflict: null,
        lastError: '',
        lastSyncedAt: new Date().toISOString(),
      });
      // Distinct from state:changed: the whole vault was replaced, so any page
      // showing it has to start over rather than merge what it had.
      hooks.broadcast({ type: 'sync:pulled' });
      return { action: 'pull', revision: remote.revision };
    }

    const blob = await hooks.readBlob();
    if (!blob) throw new Error('There is no vault to upload yet.');
    const revision = sync.nextRevision(remote);
    await sync.pushRemote(config, session, {
      blob,
      revision,
      updatedAt: new Date().toISOString(),
      device: config.deviceName || deviceName(),
    });
    await setState({
      revision,
      dirty: false,
      conflict: null,
      lastError: '',
      lastSyncedAt: new Date().toISOString(),
    });
    hooks.broadcast({ type: 'sync:changed' });
    return { action: 'push', revision };
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
  await setState({
    revision: remote.revision,
    dirty: false,
    conflict: null,
    lastError: '',
    lastSyncedAt: new Date().toISOString(),
  });
  hooks.broadcast({ type: 'sync:pulled' });
  return { ok: true, revision: remote.revision };
}

// Settling a conflict is just a sync with the direction chosen by the user.
export async function resolveConflict(choice) {
  if (choice !== 'local' && choice !== 'remote') {
    throw new Error('Choose which copy to keep.');
  }
  return syncNow({ resolve: choice });
}

// Called right after an unlock: pick up whatever another machine has published.
export async function syncOnUnlock() {
  const session = await getSession();
  if (!session) return;
  await ensureAlarm();
  syncNow().catch(() => {});
}

export { SYNC_ALARM };
