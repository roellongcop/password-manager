// Optional Firebase sync.
//
// What travels: the same AES-256-GCM blob that sits on disk, and nothing else.
// The master password never leaves the machine, the key is never derived
// anywhere but here, and the server cannot read a single field. Firebase is a
// dumb shelf for one opaque string.
//
// Spoken over the REST APIs with plain fetch rather than the Firebase SDK: a
// password manager should not ship a large third-party bundle it has never read,
// and MV3 forbids loading it remotely anyway.
//
// The sync account is deliberately a different credential from the master
// password. If they were the same, a value derived from the master password
// would be sent to Google on every sign-in.

const IDENTITY = 'https://identitytoolkit.googleapis.com/v1/accounts';
const SECURE_TOKEN = 'https://securetoken.googleapis.com/v1/token';
const FIRESTORE = 'https://firestore.googleapis.com/v1';

// The document each account owns. The rules in the README pin it to the signed-in
// user, so one account can never read another's.
export function documentPath(config, uid) {
  return `projects/${config.projectId}/databases/(default)/documents/vaults/${uid}`;
}

export function documentUrl(config, uid) {
  return `${FIRESTORE}/${documentPath(config, uid)}`;
}

export function isConfigured(config) {
  return Boolean(config && config.apiKey && config.projectId);
}

// Pull the two values Keyring needs out of whatever the Firebase console shows.
//
// The console gives a JS snippet, not JSON: unquoted keys, trailing comments,
// sometimes the whole surrounding <script> block. Rather than parse JavaScript,
// look for the two keys by name -- anything else in there is irrelevant here.
export function parseFirebaseConfig(text) {
  const source = String(text || '');
  const find = (key) => {
    const at = source.indexOf(key);
    if (at < 0) return '';
    // Everything after the key up to the end of the quoted value that follows.
    const value = source.slice(at + key.length).match(/^["']?\s*[:=]\s*["']([^"']+)["']/);
    return value ? value[1].trim() : '';
  };

  let projectId = find('projectId');
  const apiKey = find('apiKey');
  // A config without projectId still usually carries it inside authDomain
  // (my-vault.firebaseapp.com) or storageBucket.
  if (!projectId) {
    const domain = find('authDomain') || find('storageBucket');
    projectId = domain.split('.')[0] || '';
  }
  return { apiKey, projectId };
}

async function asJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error('The server sent something that is not JSON.');
  }
}

// Firebase reports failures as a machine-readable code; turn the ones a person
// can act on into something readable and leave the rest recognisable.
function authError(payload, fallback) {
  const code = payload?.error?.message || '';
  const readable = {
    EMAIL_EXISTS: 'That email already has a sync account.',
    EMAIL_NOT_FOUND: 'No sync account for that email.',
    INVALID_PASSWORD: 'Wrong sync password.',
    INVALID_LOGIN_CREDENTIALS: 'That email and password did not match.',
    USER_DISABLED: 'That sync account has been disabled.',
    WEAK_PASSWORD: 'The sync password needs at least six characters.',
    TOO_MANY_ATTEMPTS_TRY_LATER: 'Too many attempts. Try again in a few minutes.',
    OPERATION_NOT_ALLOWED: 'Email sign-in is not switched on in that Firebase project.',
    API_KEY_INVALID: 'That Firebase API key is not valid.',
  };
  return new Error(readable[code.split(' : ')[0]] || code || fallback);
}

async function identityCall(config, action, body, fetchImpl = fetch) {
  const response = await fetchImpl(`${IDENTITY}:${action}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, returnSecureToken: true }),
  });
  const payload = await asJson(response);
  if (!response.ok) throw authError(payload, `Sync sign-in failed (${response.status}).`);

  return {
    uid: payload.localId,
    email: payload.email,
    idToken: payload.idToken,
    refreshToken: payload.refreshToken,
    // A minute of slack, so a token is never used in the second it expires.
    expiresAt: Date.now() + (Number(payload.expiresIn) || 3600) * 1000 - 60_000,
  };
}

export function signIn(config, email, password, fetchImpl) {
  return identityCall(config, 'signInWithPassword', { email, password }, fetchImpl);
}

export function signUp(config, email, password, fetchImpl) {
  return identityCall(config, 'signUp', { email, password }, fetchImpl);
}

export async function refreshSession(config, refreshToken, fetchImpl = fetch) {
  const response = await fetchImpl(`${SECURE_TOKEN}?key=${encodeURIComponent(config.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  const payload = await asJson(response);
  if (!response.ok) throw authError(payload, 'The sync session expired. Sign in again.');

  return {
    uid: payload.user_id,
    idToken: payload.id_token,
    refreshToken: payload.refresh_token || refreshToken,
    expiresAt: Date.now() + (Number(payload.expires_in) || 3600) * 1000 - 60_000,
  };
}

// ------------------------------------------------------------------ documents

// Firestore's REST shape wraps every value in its type. Only three fields are
// stored, so the mapping is written out rather than generalised.
function toDocument({ blob, revision, updatedAt, device }) {
  return {
    fields: {
      blob: { stringValue: JSON.stringify(blob) },
      revision: { integerValue: String(revision) },
      updatedAt: { stringValue: updatedAt },
      device: { stringValue: device || '' },
    },
  };
}

function fromDocument(document) {
  const fields = document?.fields;
  if (!fields || !fields.blob) return null;
  let blob;
  try {
    blob = JSON.parse(fields.blob.stringValue);
  } catch {
    throw new Error('The synced vault is damaged and could not be read.');
  }
  return {
    blob,
    revision: Number(fields.revision?.integerValue || 0),
    updatedAt: fields.updatedAt?.stringValue || '',
    device: fields.device?.stringValue || '',
  };
}

export async function fetchRemote(config, session, fetchImpl = fetch) {
  const response = await fetchImpl(documentUrl(config, session.uid), {
    headers: { authorization: `Bearer ${session.idToken}` },
  });

  // Nothing uploaded yet is a normal state, not a failure.
  if (response.status === 404) return null;

  const payload = await asJson(response);
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Firestore refused the read. Check the security rules and that Firestore is enabled.',
      );
    }
    throw new Error(payload?.error?.message || `Could not read the synced vault (${response.status}).`);
  }
  return fromDocument(payload);
}

export async function pushRemote(config, session, entry, fetchImpl = fetch) {
  const response = await fetchImpl(documentUrl(config, session.uid), {
    method: 'PATCH',
    headers: {
      authorization: `Bearer ${session.idToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(toDocument(entry)),
  });

  const payload = await asJson(response);
  if (!response.ok) {
    if (response.status === 403) {
      throw new Error(
        'Firestore refused the write. Check the security rules and that Firestore is enabled.',
      );
    }
    throw new Error(payload?.error?.message || `Could not upload the vault (${response.status}).`);
  }
  return fromDocument(payload);
}

// ------------------------------------------------------------------ deciding

// Which way the next sync should go.
//
// `revision` is the revision this machine last agreed with the server on, and
// `dirty` says whether the vault has changed since.
//
// When the server has moved on, its copy wins -- including over edits here that
// never made it up. That is one simple rule instead of a prompt, and the cost of
// it is that unsent changes on this machine are discarded.
export function decideSync(local, remote) {
  // Nothing on the server yet: this device seeds it.
  if (!remote) return 'push';
  if (remote.revision === local.revision) return local.dirty ? 'push' : 'none';
  if (remote.revision > local.revision) return 'pull';
  // The server is behind us, which means our last push did not land.
  return 'push';
}

export function nextRevision(remote) {
  return (remote ? remote.revision : 0) + 1;
}
