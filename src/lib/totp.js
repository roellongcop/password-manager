// RFC 6238 time-based one-time passwords, RFC 4648 base32, both on WebCrypto.

const encoder = new TextEncoder();
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const DEFAULT_TOTP = Object.freeze({
  algorithm: 'SHA-1',
  digits: 6,
  period: 30,
});

export function base32Decode(input) {
  // Tolerate the way real sites present secrets: spaces, lowercase, padding.
  const cleaned = String(input || '')
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/[\s-]/g, '');
  if (!cleaned) throw new Error('Empty TOTP secret.');

  let bits = 0;
  let value = 0;
  const output = [];
  for (const character of cleaned) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error('TOTP secret is not valid base32: ' + character);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function hmacName(algorithm) {
  const normalized = String(algorithm || 'SHA-1').toUpperCase().replace(/^SHA(\d)/, 'SHA-$1');
  if (!['SHA-1', 'SHA-256', 'SHA-512'].includes(normalized)) {
    throw new Error('Unsupported TOTP algorithm: ' + algorithm);
  }
  return normalized;
}

export async function hotp(secretBytes, counter, algorithm = 'SHA-1', digits = 6) {
  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: hmacName(algorithm) },
    false,
    ['sign'],
  );

  const message = new ArrayBuffer(8);
  const view = new DataView(message);
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return String(binary % 10 ** digits).padStart(digits, '0');
}

export async function generateTotp(config, atMs = Date.now()) {
  const settings = { ...DEFAULT_TOTP, ...(config || {}) };
  const secret = settings.secret instanceof Uint8Array
    ? settings.secret
    : base32Decode(settings.secret);
  const counter = Math.floor(atMs / 1000 / settings.period);
  return hotp(secret, counter, settings.algorithm, settings.digits);
}

export function secondsRemaining(period = 30, atMs = Date.now()) {
  return period - (Math.floor(atMs / 1000) % period);
}

// Accepts a bare base32 secret or a full otpauth:// URI, so a pasted QR payload
// just works.
export function parseTotpInput(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  if (!/^otpauth:\/\//i.test(raw)) {
    return { ...DEFAULT_TOTP, secret: raw.replace(/[\s-]/g, '') };
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('That otpauth:// link could not be parsed.');
  }
  if (url.host.toLowerCase() !== 'totp') {
    throw new Error('Only otpauth://totp links are supported.');
  }

  const params = url.searchParams;
  const secret = params.get('secret');
  if (!secret) throw new Error('That otpauth:// link has no secret.');

  const label = decodeURIComponent(url.pathname.replace(/^\//, ''));
  const [issuerFromLabel, account] = label.includes(':')
    ? label.split(/:(.+)/)
    : ['', label];

  return {
    secret: secret.replace(/[\s-]/g, ''),
    algorithm: hmacName(params.get('algorithm') || 'SHA-1'),
    digits: Number(params.get('digits')) || 6,
    period: Number(params.get('period')) || 30,
    issuer: params.get('issuer') || issuerFromLabel || '',
    account: account || '',
  };
}

export function buildOtpAuthUri({ secret, issuer, account, algorithm, digits, period }) {
  const label = encodeURIComponent(`${issuer || ''}${issuer ? ':' : ''}${account || ''}`);
  const params = new URLSearchParams({ secret });
  if (issuer) params.set('issuer', issuer);
  if (algorithm && algorithm !== 'SHA-1') params.set('algorithm', algorithm.replace('-', ''));
  if (digits && digits !== 6) params.set('digits', String(digits));
  if (period && period !== 30) params.set('period', String(period));
  return `otpauth://totp/${label}?${params.toString()}`;
}

export function asciiSecret(text) {
  return encoder.encode(text);
}
