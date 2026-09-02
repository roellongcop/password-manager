// The vault model. Pure data functions only -- no chrome APIs, no crypto -- so
// this file can be exercised straight from tests/test.html.

export const SCHEMA_VERSION = 1;

// 'totp' is a standalone authenticator entry: a code with no password attached,
// for accounts whose password lives somewhere else (or nowhere).
export const ITEM_TYPES = Object.freeze(['login', 'note', 'card', 'totp']);

export const TOTP_DEFAULTS = Object.freeze({
  algorithm: 'SHA-1',
  digits: 6,
  period: 30,
});

// Both logins and standalone entries carry their code the same way, so anything
// that shows or fills a code can take either.
export function hasTotp(item) {
  return Boolean(item && item.totp);
}

export function totpConfig(item) {
  return {
    secret: item.totp || '',
    algorithm: item.totpAlgorithm || TOTP_DEFAULTS.algorithm,
    digits: Number(item.totpDigits) || TOTP_DEFAULTS.digits,
    period: Number(item.totpPeriod) || TOTP_DEFAULTS.period,
  };
}

export function isDefaultTotpConfig(item) {
  const config = totpConfig(item);
  return (
    config.algorithm === TOTP_DEFAULTS.algorithm &&
    config.digits === TOTP_DEFAULTS.digits &&
    config.period === TOTP_DEFAULTS.period
  );
}

export function defaultSettings() {
  return {
    // 0 = stay unlocked until the browser closes, which clears the key either way.
    autoLockMinutes: 0,
    clipboardClearSeconds: 30,
    lockOnBrowserClose: true,
    showInlineIcon: true,
    offerToSave: true,
    theme: 'system', // 'system' | 'light' | 'dark'
    neverDomains: [],
  };
}

export function emptyVault() {
  return {
    version: SCHEMA_VERSION,
    createdAt: nowIso(),
    items: [],
    folders: [],
    settings: defaultSettings(),
  };
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function newItem(type = 'login', fields = {}) {
  const stamp = nowIso();
  const base = {
    id: uuid(),
    type,
    name: '',
    folder: '',
    favorite: false,
    notes: '',
    customFields: [],
    createdAt: stamp,
    updatedAt: stamp,
    lastUsedAt: null,
  };
  if (type === 'login') {
    Object.assign(base, {
      username: '',
      password: '',
      uris: [],
      totp: '',
      totpAlgorithm: TOTP_DEFAULTS.algorithm,
      totpDigits: TOTP_DEFAULTS.digits,
      totpPeriod: TOTP_DEFAULTS.period,
      allowInsecure: false,
      passwordHistory: [],
    });
  } else if (type === 'totp') {
    // name holds the issuer, username the account, so search, sorting, CSV and
    // the item list all work on it without special cases.
    Object.assign(base, {
      username: '',
      totp: '',
      totpAlgorithm: TOTP_DEFAULTS.algorithm,
      totpDigits: TOTP_DEFAULTS.digits,
      totpPeriod: TOTP_DEFAULTS.period,
      uris: [],
    });
  } else if (type === 'card') {
    Object.assign(base, {
      cardholder: '',
      number: '',
      brand: '',
      expMonth: '',
      expYear: '',
      cvv: '',
    });
  }
  return Object.assign(base, fields);
}

// Keeps password history and timestamps honest so callers do not have to.
export function upsertItem(vault, item) {
  const items = vault.items.slice();
  const index = items.findIndex((candidate) => candidate.id === item.id);
  const next = { ...item, updatedAt: nowIso() };

  if (index === -1) {
    items.push(next);
  } else {
    const previous = items[index];
    next.createdAt = previous.createdAt || next.createdAt;
    if (
      next.type === 'login' &&
      previous.password &&
      previous.password !== next.password
    ) {
      next.passwordHistory = [
        { password: previous.password, changedAt: previous.updatedAt || nowIso() },
        ...(previous.passwordHistory || []),
      ].slice(0, 10);
    } else {
      next.passwordHistory = previous.passwordHistory || next.passwordHistory || [];
    }
    items[index] = next;
  }
  return { ...vault, items };
}

export function deleteItem(vault, id) {
  return { ...vault, items: vault.items.filter((item) => item.id !== id) };
}

export function getItem(vault, id) {
  return vault.items.find((item) => item.id === id) || null;
}

export function touchItem(vault, id) {
  const items = vault.items.map((item) =>
    item.id === id ? { ...item, lastUsedAt: nowIso() } : item,
  );
  return { ...vault, items };
}

export function searchItems(items, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return items;
  const terms = needle.split(/\s+/);
  return items.filter((item) => {
    const haystack = [
      item.name,
      item.username,
      item.folder,
      item.notes,
      item.cardholder,
      ...(item.uris || []).map((entry) => entry.uri),
      ...(item.customFields || []).map((field) => field.name),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function sortItems(items) {
  return items.slice().sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    const nameA = (a.name || a.username || '').toLowerCase();
    const nameB = (b.name || b.username || '').toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

export function folderNames(vault) {
  const names = new Set();
  for (const item of vault.items) if (item.folder) names.add(item.folder);
  for (const folder of vault.folders || []) if (folder) names.add(folder);
  return [...names].sort((a, b) => a.localeCompare(b));
}

// Strips secrets before anything leaves the trusted side of the extension.
export function publicSummary(item) {
  return {
    id: item.id,
    type: item.type,
    name: item.name || primaryUri(item) || item.username || 'Untitled',
    username: item.username || '',
    hasTotp: Boolean(item.totp),
    onlyTotp: item.type === 'totp',
    favorite: Boolean(item.favorite),
  };
}

export function primaryUri(item) {
  const first = (item.uris || [])[0];
  return first ? first.uri : '';
}

// Forward-only migration. Every future schema bump adds a branch here.
export function migrate(vault) {
  const next = { ...vault };
  if (!Array.isArray(next.items)) next.items = [];
  if (!Array.isArray(next.folders)) next.folders = [];
  next.settings = { ...defaultSettings(), ...(next.settings || {}) };
  next.items = next.items.map((item) => {
    const merged = { ...newItem(item.type || 'login'), ...item };
    merged.uris = (merged.uris || []).map((entry) =>
      typeof entry === 'string' ? { uri: entry, matchType: 'domain' } : entry,
    );
    return merged;
  });
  next.version = SCHEMA_VERSION;
  return next;
}

// Rough strength signal for the master password and generated entries. This is a
// heuristic for the UI meter, not a security control.
export function passwordStrength(password) {
  const value = String(password || '');
  if (!value) return { score: 0, label: 'Empty', bits: 0 };
  let pool = 0;
  if (/[a-z]/.test(value)) pool += 26;
  if (/[A-Z]/.test(value)) pool += 26;
  if (/[0-9]/.test(value)) pool += 10;
  if (/[^A-Za-z0-9]/.test(value)) pool += 33;
  const unique = new Set(value).size;
  const variety = Math.min(1, unique / Math.max(8, value.length * 0.6));
  const bits = Math.round(value.length * Math.log2(pool || 1) * (0.55 + 0.45 * variety));
  const score = bits < 40 ? 1 : bits < 60 ? 2 : bits < 90 ? 3 : 4;
  const label = ['Empty', 'Weak', 'Fair', 'Strong', 'Very strong'][score];
  return { score, label, bits };
}
