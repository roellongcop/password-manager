// CSV import and export.
//
// Keyring has its own column format (CSV_COLUMNS below) and its export round-trips
// straight back through the importer. Any other CSV works too: the header is
// matched against a set of ordinary column-name synonyms, and whatever cannot be
// recognised is left for the user to map by hand rather than guessed at.

import { newItem } from './vault.js';
import { registrableDomain, suggestedName } from './matcher.js';
import { parseTotpInput } from './totp.js';

// RFC 4180: double quotes escape themselves, quoted fields may hold commas and
// newlines, and CRLF or LF both end a record.
export function parseCsv(text, delimiter = ',') {
  const input = String(text || '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let sawAnyChar = false;

  for (let i = 0; i < input.length; i++) {
    const character = input[i];

    if (inQuotes) {
      if (character === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      inQuotes = true;
      sawAnyChar = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
      sawAnyChar = true;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawAnyChar = false;
    } else {
      field += character;
      sawAnyChar = true;
    }
  }

  if (field.length > 0 || sawAnyChar || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Drop the trailing empty record a file ending in a newline produces.
  return rows.filter((entry) => entry.length > 1 || (entry[0] || '').trim() !== '');
}

export function detectDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/)[0] || '';
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

// Keyring's own CSV format, in order. This is what the exporter writes and what a
// hand-written file should use to import with no mapping at all.
export const CSV_COLUMNS = Object.freeze([
  'type',
  'name',
  'folder',
  'favorite',
  'username',
  'password',
  'url',
  'totp',
  'notes',
  'cardholder',
  'number',
  'expMonth',
  'expYear',
  'cvv',
]);

// Ordinary synonyms, so a spreadsheet built by hand or exported from something
// else lines up without editing the headings first.
export const FIELD_ALIASES = Object.freeze({
  type: ['type', 'kind', 'item type'],
  name: ['name', 'title', 'item', 'item name', 'label', 'display name'],
  folder: ['folder', 'category', 'group', 'collection', 'tag'],
  favorite: ['favorite', 'favourite', 'starred', 'pinned'],
  username: ['username', 'user name', 'user', 'login', 'account', 'email', 'e-mail'],
  password: ['password', 'pass', 'passphrase', 'secret'],
  url: ['url', 'urls', 'website', 'web site', 'site', 'address', 'link', 'domain'],
  totp: ['totp', 'otp', 'otpsecret', 'otp secret', 'authenticator', '2fa', 'two-factor secret'],
  notes: ['notes', 'note', 'comment', 'comments', 'description', 'extra'],
  cardholder: ['cardholder', 'card holder', 'name on card'],
  number: ['number', 'card number', 'cardnumber', 'pan'],
  expMonth: ['expmonth', 'exp month', 'expiry month', 'expiration month', 'exp mm'],
  expYear: ['expyear', 'exp year', 'expiry year', 'expiration year', 'exp yy', 'exp yyyy'],
  cvv: ['cvv', 'cvc', 'security code', 'card code'],
});

export const IGNORED = '__ignore__';

export function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase().replace(/^"|"$/g, '').replace(/[_-]+/g, ' ');
}

// Guess a column mapping from the header row. Anything unrecognised is ignored
// rather than guessed at; the import screen lets the mapping be corrected.
export function guessMapping(headerRow) {
  const mapping = {};
  const taken = new Set();
  headerRow.forEach((rawHeader, index) => {
    const header = normalizeHeader(rawHeader);
    let assigned = IGNORED;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (taken.has(field)) continue;
      if (aliases.some((alias) => normalizeHeader(alias) === header)) {
        assigned = field;
        taken.add(field);
        break;
      }
    }
    mapping[index] = assigned;
  });
  return mapping;
}

export function looksLikeHeader(row) {
  const normalized = row.map(normalizeHeader);
  const known = new Set(Object.values(FIELD_ALIASES).flat().map(normalizeHeader));
  return normalized.filter((header) => known.has(header)).length >= 2;
}

// `hasHeader` overrides the guess, for a file whose first row really is data.
export function analyze(text, options = {}) {
  const delimiter = options.delimiter || detectDelimiter(text);
  const rows = parseCsv(text, delimiter);
  if (rows.length === 0) {
    return { rows: [], delimiter, header: null, mapping: {}, dataRows: [] };
  }

  const hasHeader =
    typeof options.hasHeader === 'boolean' ? options.hasHeader : looksLikeHeader(rows[0]);

  if (hasHeader) {
    return {
      rows,
      delimiter,
      header: rows[0],
      mapping: guessMapping(rows[0]),
      dataRows: rows.slice(1),
    };
  }

  // No header to go on: every column starts as Ignore and is mapped by hand.
  const mapping = {};
  const columnCount = Math.max(...rows.map((row) => row.length));
  for (let index = 0; index < columnCount; index++) mapping[index] = IGNORED;
  return { rows, delimiter, header: null, mapping, dataRows: rows };
}

const TRUTHY = new Set(['1', 'true', 'yes', 'y', 'x', '★']);

function readBoolean(value) {
  return TRUTHY.has(String(value || '').trim().toLowerCase());
}

function readType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['login', 'password', 'credential'].includes(text)) return 'login';
  if (['note', 'secure note', 'securenote', 'text'].includes(text)) return 'note';
  if (['card', 'payment', 'credit card'].includes(text)) return 'card';
  return '';
}

export function rowsToItems(dataRows, mapping) {
  const items = [];
  const skipped = [];

  dataRows.forEach((row, rowIndex) => {
    const record = {};
    for (const [index, field] of Object.entries(mapping)) {
      if (field === IGNORED) continue;
      const value = (row[Number(index)] || '').trim();
      if (value) record[field] = value;
    }

    if (!Object.keys(record).length) return;

    // An explicit type column wins; otherwise infer from what the row carries.
    const type =
      readType(record.type) ||
      (record.number || record.cardholder || record.cvv
        ? 'card'
        : record.password || record.username
          ? 'login'
          : record.notes || record.name
            ? 'note'
            : '');
    if (!type) return;

    const item = newItem(type, {
      name:
        record.name ||
        (record.url ? suggestedName(record.url) : '') ||
        record.username ||
        'Imported item',
      folder: record.folder || '',
      notes: record.notes || '',
      favorite: readBoolean(record.favorite),
    });

    if (type === 'login') {
      item.username = record.username || '';
      item.password = record.password || '';
      if (record.url) {
        item.uris = splitUrls(record.url).map((uri) => ({ uri, matchType: 'domain' }));
      }
      if (record.totp) {
        try {
          const parsed = parseTotpInput(record.totp);
          item.totp = parsed ? parsed.secret : '';
        } catch {
          skipped.push({ row: rowIndex + 1, reason: 'unreadable TOTP secret, imported without it' });
        }
      }
    }

    if (type === 'card') {
      item.cardholder = record.cardholder || '';
      item.number = record.number || '';
      item.expMonth = record.expMonth || '';
      item.expYear = record.expYear || '';
      item.cvv = record.cvv || '';
    }

    items.push(item);
  });

  return { items, skipped };
}

function splitUrls(value) {
  return String(value)
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 5);
}

// De-duplicate against what is already in the vault: same registrable domain and
// same username means the same account.
export function dedupeAgainst(existingItems, incomingItems) {
  const seen = new Set(existingItems.map((item) => keyFor(item)).filter(Boolean));
  const fresh = [];
  const duplicates = [];
  for (const item of incomingItems) {
    const key = keyFor(item);
    if (key && seen.has(key)) {
      duplicates.push(item);
    } else {
      if (key) seen.add(key);
      fresh.push(item);
    }
  }
  return { fresh, duplicates };
}

function keyFor(item) {
  if (item.type !== 'login') return null;
  const uri = (item.uris || [])[0];
  const domain = uri ? registrableDomain(uri.uri || uri) : '';
  if (!domain && !item.username) return null;
  return `${domain} ${(item.username || '').toLowerCase()}`;
}

function cellFor(item, column) {
  switch (column) {
    case 'type':
      return item.type;
    case 'url':
      return (item.uris || []).map((entry) => entry.uri).join(' ');
    case 'favorite':
      return item.favorite ? 'true' : '';
    default:
      return item[column] ?? '';
  }
}

export function itemsToCsv(items) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const item of items) {
    lines.push(CSV_COLUMNS.map((column) => escapeCsvField(cellFor(item, column))).join(','));
  }
  return lines.join('\r\n');
}

// A starter file: the header plus one example of each item type, so a vault can be
// filled in by hand in a spreadsheet and imported.
export function templateCsv() {
  const examples = [
    {
      type: 'login',
      name: 'Example site',
      folder: 'Personal',
      favorite: 'true',
      username: 'me@example.com',
      password: 'replace-me',
      url: 'https://example.com',
      totp: '',
      notes: 'Anything you want to remember',
    },
    { type: 'note', name: 'Wi-Fi', notes: 'The key is on the router' },
    {
      type: 'card',
      name: 'Everyday card',
      cardholder: 'A Lovelace',
      number: '4111111111111111',
      expMonth: '04',
      expYear: '2029',
      cvv: '123',
    },
  ];
  const lines = [CSV_COLUMNS.join(',')];
  for (const example of examples) {
    lines.push(CSV_COLUMNS.map((column) => escapeCsvField(example[column] ?? '')).join(','));
  }
  return lines.join('\r\n');
}

export function escapeCsvField(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}
