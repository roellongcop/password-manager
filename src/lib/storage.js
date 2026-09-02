// Thin wrappers over the two storage areas Keyring uses.
//
//   local   -- the encrypted vault blob and the "has been set up" marker. On disk.
//   session -- the raw AES key while unlocked. Memory only, cleared when the
//              browser closes, and locked to TRUSTED_CONTEXTS so no content
//              script can ever read it.

export const KEYS = Object.freeze({
  BLOB: 'vaultBlob',
  SESSION_KEY: 'sessionKey',
  UNLOCK_EXPIRES: 'unlockExpires',
  PENDING_CAPTURE: 'pendingCapture',
  LAST_USERNAME: 'lastUsername',
});

let accessLevelSet = false;

export async function ensureSessionAccessLevel() {
  if (accessLevelSet) return;
  try {
    await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    // Older Chromium builds default to TRUSTED_CONTEXTS anyway.
  }
  accessLevelSet = true;
}

export const local = {
  async get(key, fallback = undefined) {
    const result = await chrome.storage.local.get(key);
    return key in result ? result[key] : fallback;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
  async clear() {
    await chrome.storage.local.clear();
  },
};

export const session = {
  async get(key, fallback = undefined) {
    await ensureSessionAccessLevel();
    const result = await chrome.storage.session.get(key);
    return key in result ? result[key] : fallback;
  },
  async set(key, value) {
    await ensureSessionAccessLevel();
    await chrome.storage.session.set({ [key]: value });
  },
  async remove(key) {
    await ensureSessionAccessLevel();
    await chrome.storage.session.remove(key);
  },
  async clear() {
    await ensureSessionAccessLevel();
    await chrome.storage.session.clear();
  },
};
