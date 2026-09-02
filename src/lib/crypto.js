// Vault cryptography. Everything here runs on WebCrypto; nothing is rolled by hand
// except base64 and the byte plumbing.
//
// Master password --PBKDF2--> 256-bit key --AES-GCM--> the whole vault as one blob.
// The master password is never stored, and there is deliberately no separate
// verifier hash: a wrong password shows up as a GCM auth-tag failure on decrypt.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const BLOB_VERSION = 1;

// OWASP's 2023 floor for PBKDF2-SHA256. Stored with the blob so it can be raised
// later without stranding vaults written by an older build.
export const KDF_DEFAULTS = Object.freeze({
  name: 'PBKDF2',
  hash: 'SHA-256',
  iterations: 600000,
});

export const SALT_BYTES = 16;
export const IV_BYTES = 12;
export const KEY_BITS = 256;

export class WrongPasswordError extends Error {
  constructor() {
    super('Incorrect master password, or the vault data is damaged.');
    this.name = 'WrongPasswordError';
  }
}

export function randomBytes(count) {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toBase64(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  // Chunked so a large vault does not blow the argument limit of String.fromCharCode.
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, view.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function fromBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// NFKC so a password typed with a composed vs decomposed accent still unlocks.
export async function deriveKey(password, salt, kdf = KDF_DEFAULTS) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(password).normalize('NFKC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: kdf.iterations, hash: kdf.hash },
    material,
    KEY_BITS,
  );
  return new Uint8Array(bits);
}

async function importAesKey(rawKey, usages) {
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, usages);
}

// Encrypt a vault object into the on-disk / on-export blob shape.
export async function seal(vault, rawKey, kdf = KDF_DEFAULTS, salt) {
  if (!salt) throw new Error('seal() needs the salt the key was derived from');
  const iv = randomBytes(IV_BYTES);
  const key = await importAesKey(rawKey, ['encrypt']);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(JSON.stringify(vault)),
  );
  return {
    v: BLOB_VERSION,
    kdf: {
      name: kdf.name,
      hash: kdf.hash,
      iterations: kdf.iterations,
      salt: toBase64(salt),
    },
    iv: toBase64(iv),
    ct: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function open(blob, rawKey) {
  assertBlob(blob);
  const key = await importAesKey(rawKey, ['decrypt']);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(blob.iv) },
      key,
      fromBase64(blob.ct),
    );
  } catch {
    throw new WrongPasswordError();
  }
  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Vault decrypted but its contents are not valid JSON.');
  }
}

// Create a brand new sealed vault from a master password.
export async function create(vault, password) {
  const salt = randomBytes(SALT_BYTES);
  const rawKey = await deriveKey(password, salt, KDF_DEFAULTS);
  const blob = await seal(vault, rawKey, KDF_DEFAULTS, salt);
  return { blob, rawKey };
}

// Derive from the params carried by the blob itself, then decrypt.
export async function unlock(blob, password) {
  assertBlob(blob);
  const salt = fromBase64(blob.kdf.salt);
  const rawKey = await deriveKey(password, salt, blob.kdf);
  const vault = await open(blob, rawKey);
  return { vault, rawKey, salt, kdf: blob.kdf };
}

// Re-seal an already-open vault using the key we still hold.
export async function reseal(vault, rawKey, blob) {
  assertBlob(blob);
  return seal(vault, rawKey, blob.kdf, fromBase64(blob.kdf.salt));
}

export function assertBlob(blob) {
  if (!blob || typeof blob !== 'object') throw new Error('Not a vault file.');
  if (typeof blob.ct !== 'string' || typeof blob.iv !== 'string') {
    throw new Error('Not a vault file: missing ciphertext.');
  }
  const kdf = blob.kdf;
  if (!kdf || typeof kdf.salt !== 'string' || !Number.isInteger(kdf.iterations)) {
    throw new Error('Not a vault file: missing key-derivation parameters.');
  }
  if (kdf.name !== 'PBKDF2') throw new Error('Unsupported key derivation: ' + kdf.name);
  if (blob.v > BLOB_VERSION) {
    throw new Error('This vault was written by a newer version of Keyring.');
  }
  return true;
}
