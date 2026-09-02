// Password and passphrase generation.
//
// Every random draw goes through randomInt(), which rejects out-of-range draws
// rather than taking a modulus -- a plain `% n` skews the distribution toward the
// low end of the alphabet whenever n does not divide 2^32.

import { WORDS } from './wordlist.js';

export const SETS = Object.freeze({
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: '!@#$%^&*()-_=+[]{}<>?,.:;~',
});

// Characters that are easy to misread when a password has to be typed by hand.
export const AMBIGUOUS = 'Il1O0oB8S5Z2G6q9gy';

export const DEFAULT_OPTIONS = Object.freeze({
  length: 20,
  lower: true,
  upper: true,
  digits: true,
  symbols: true,
  excludeAmbiguous: false,
  minDigits: 1,
  minSymbols: 1,
});

export const DEFAULT_PASSPHRASE_OPTIONS = Object.freeze({
  words: 5,
  separator: '-',
  capitalize: true,
  includeNumber: true,
});

export function randomInt(maxExclusive) {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('randomInt needs a positive integer bound');
  }
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const scratch = new Uint32Array(1);
  let draw;
  do {
    crypto.getRandomValues(scratch);
    draw = scratch[0];
  } while (draw >= limit);
  return draw % maxExclusive;
}

export function pick(alphabet) {
  return alphabet[randomInt(alphabet.length)];
}

export function shuffle(items) {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function applyExclusions(alphabet, excludeAmbiguous) {
  if (!excludeAmbiguous) return alphabet;
  return [...alphabet].filter((character) => !AMBIGUOUS.includes(character)).join('');
}

export function generatePassword(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const length = Math.max(4, Math.min(128, Number(config.length) || 20));

  const active = [];
  if (config.lower) active.push(applyExclusions(SETS.lower, config.excludeAmbiguous));
  if (config.upper) active.push(applyExclusions(SETS.upper, config.excludeAmbiguous));
  if (config.digits) active.push(applyExclusions(SETS.digits, config.excludeAmbiguous));
  if (config.symbols) active.push(applyExclusions(SETS.symbols, config.excludeAmbiguous));

  // Never hand back an empty string because every class got switched off.
  if (active.length === 0) active.push(applyExclusions(SETS.lower, config.excludeAmbiguous));

  const pool = active.join('');
  const required = [];

  // One guaranteed character from each enabled class, plus any extra minimums.
  for (const alphabet of active) required.push(pick(alphabet));
  if (config.digits) {
    const digits = applyExclusions(SETS.digits, config.excludeAmbiguous);
    for (let i = 1; i < (config.minDigits || 0); i++) required.push(pick(digits));
  }
  if (config.symbols) {
    const symbols = applyExclusions(SETS.symbols, config.excludeAmbiguous);
    for (let i = 1; i < (config.minSymbols || 0); i++) required.push(pick(symbols));
  }

  const characters = required.slice(0, length);
  while (characters.length < length) characters.push(pick(pool));
  return shuffle(characters).join('');
}

export function generatePassphrase(options = {}) {
  const config = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  const count = Math.max(3, Math.min(12, Number(config.words) || 5));
  const words = [];
  for (let i = 0; i < count; i++) {
    let word = WORDS[randomInt(WORDS.length)];
    if (config.capitalize) word = word[0].toUpperCase() + word.slice(1);
    words.push(word);
  }
  if (config.includeNumber) {
    const position = randomInt(words.length);
    words[position] = words[position] + randomInt(100);
  }
  return words.join(config.separator ?? '-');
}

// Entropy of the generator's own choices, which is the number that matters --
// not the shape of the string it happened to produce.
export function passwordEntropyBits(options = {}) {
  const config = { ...DEFAULT_OPTIONS, ...options };
  let pool = 0;
  if (config.lower) pool += applyExclusions(SETS.lower, config.excludeAmbiguous).length;
  if (config.upper) pool += applyExclusions(SETS.upper, config.excludeAmbiguous).length;
  if (config.digits) pool += applyExclusions(SETS.digits, config.excludeAmbiguous).length;
  if (config.symbols) pool += applyExclusions(SETS.symbols, config.excludeAmbiguous).length;
  if (pool === 0) pool = 26;
  return Math.round((Number(config.length) || 20) * Math.log2(pool));
}

export function passphraseEntropyBits(options = {}) {
  const config = { ...DEFAULT_PASSPHRASE_OPTIONS, ...options };
  const count = Math.max(3, Math.min(12, Number(config.words) || 5));
  const base = count * Math.log2(WORDS.length);
  return Math.round(base + (config.includeNumber ? Math.log2(100 * count) : 0));
}

export const WORD_COUNT = WORDS.length;
