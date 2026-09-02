// One suite, two runners: `node tests/run.mjs` for the command line and
// tests/test.html in the browser. Everything here is pure library code, so both
// see identical results.

import * as vaultCrypto from '../src/lib/crypto.js';
import * as model from '../src/lib/vault.js';
import * as matcher from '../src/lib/matcher.js';
import * as csv from '../src/lib/csv.js';
import * as totp from '../src/lib/totp.js';
import * as generator from '../src/lib/generator.js';
import * as qr from '../src/lib/qr.js';
import * as sync from '../src/lib/sync.js';
import { QR_FIXTURES, fixtureMatrix } from './qr-fixtures.js';

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message || 'assertion failed');
}

function equal(actual, expected, message) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  assert(same, `${message || 'not equal'}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

// ------------------------------------------------------------------- crypto

test('vault round-trips through seal and open', async () => {
  const vault = model.emptyVault();
  vault.items.push(model.newItem('login', { name: 'GitHub', password: 'hunter2' }));

  const { blob, rawKey } = await vaultCrypto.create(vault, 'correct horse battery staple');
  assert(!JSON.stringify(blob).includes('hunter2'), 'plaintext leaked into the blob');

  const opened = await vaultCrypto.open(blob, rawKey);
  equal(opened.items[0].password, 'hunter2', 'password survived the round trip');
});

test('the wrong master password is rejected, not silently wrong', async () => {
  const { blob } = await vaultCrypto.create(model.emptyVault(), 'right password');
  let threw = null;
  try {
    await vaultCrypto.unlock(blob, 'wrong password');
  } catch (error) {
    threw = error;
  }
  assert(threw, 'unlock with a wrong password should throw');
  assert(threw.name === 'WrongPasswordError', `expected WrongPasswordError, got ${threw.name}`);
});

test('KDF parameters travel with the blob', async () => {
  const { blob } = await vaultCrypto.create(model.emptyVault(), 'pw');
  equal(blob.kdf.iterations, vaultCrypto.KDF_DEFAULTS.iterations, 'iteration count stored');
  equal(blob.kdf.hash, 'SHA-256', 'hash stored');
  assert(typeof blob.kdf.salt === 'string' && blob.kdf.salt.length > 10, 'salt stored');
  const { vault } = await vaultCrypto.unlock(blob, 'pw');
  assert(Array.isArray(vault.items), 'unlocked using only the stored parameters');
});

test('every seal uses a fresh IV', async () => {
  const { blob, rawKey } = await vaultCrypto.create(model.emptyVault(), 'pw');
  const again = await vaultCrypto.reseal(model.emptyVault(), rawKey, blob);
  assert(blob.iv !== again.iv, 'IV must not repeat across writes');
});

test('a damaged ciphertext fails closed', async () => {
  const { blob, rawKey } = await vaultCrypto.create(model.emptyVault(), 'pw');
  // Swap the first base64 character for a different one -- hardcoding 'A' left a
  // 1-in-64 chance of "damaging" the blob into exactly itself.
  const first = blob.ct[0] === 'A' ? 'B' : 'A';
  const flipped = { ...blob, ct: first + blob.ct.slice(1) };
  let threw = false;
  try {
    await vaultCrypto.open(flipped, rawKey);
  } catch {
    threw = true;
  }
  assert(threw, 'tampered ciphertext should not decrypt');
});

// -------------------------------------------------------------------- vault

test('changing a password records the previous one', () => {
  let vault = model.emptyVault();
  const item = model.newItem('login', { name: 'X', password: 'old' });
  vault = model.upsertItem(vault, item);
  vault = model.upsertItem(vault, { ...model.getItem(vault, item.id), password: 'new' });
  equal(model.getItem(vault, item.id).passwordHistory.map((h) => h.password), ['old'], 'history');
});

test('search matches across name, username and uri', () => {
  const items = [
    model.newItem('login', { name: 'GitHub', username: 'ada', uris: [{ uri: 'https://github.com' }] }),
    model.newItem('login', { name: 'Bank', username: 'ada@example.com' }),
  ];
  equal(model.searchItems(items, 'github').length, 1, 'by name');
  equal(model.searchItems(items, 'ada').length, 2, 'by username');
  equal(model.searchItems(items, 'ada bank').length, 1, 'all terms must match');
});

test('the list is ordered by favourite, then by most recently used', () => {
  const make = (name, favorite, lastUsedAt) =>
    model.newItem('login', { name, favorite, lastUsedAt });

  const ordered = model.sortItems([
    make('Never used B', false, null),
    make('Older', false, '2026-01-01T00:00:00Z'),
    make('Newest', false, '2026-09-01T00:00:00Z'),
    make('Never used A', false, null),
    make('Favourite, never used', true, null),
  ]);

  equal(
    ordered.map((item) => item.name),
    ['Favourite, never used', 'Newest', 'Older', 'Never used A', 'Never used B'],
    'favourites pinned, then recency, then unused alphabetically',
  );
});

test('using an item moves it to the top', () => {
  let vault = model.emptyVault();
  const first = model.newItem('login', { name: 'First' });
  const second = model.newItem('login', { name: 'Second' });
  vault = model.upsertItem(vault, first);
  vault = model.upsertItem(vault, second);

  vault = model.touchItem(vault, second.id);
  equal(model.sortItems(vault.items)[0].name, 'Second', 'the used one leads');

  vault = model.touchItem(vault, first.id);
  equal(model.sortItems(vault.items)[0].name, 'First', 'and the next one takes over');
});

test('saving an item does not wind back when it was last used', () => {
  // The editor holds a clone taken when the item was opened; a copy afterwards
  // bumps the stored item. Saving the stale clone must not undo that.
  let vault = model.emptyVault();
  const item = model.newItem('login', { name: 'GitHub', password: 'old' });
  vault = model.upsertItem(vault, item);

  const draft = structuredClone(model.getItem(vault, item.id));
  vault = model.touchItem(vault, item.id);
  const used = model.getItem(vault, item.id).lastUsedAt;
  assert(used, 'the stored item now has a timestamp');
  equal(draft.lastUsedAt, null, 'the clone predates it');

  // This is what saveDraft does before upserting.
  draft.password = 'new';
  draft.lastUsedAt = model.getItem(vault, draft.id).lastUsedAt;
  vault = model.upsertItem(vault, draft);

  equal(model.getItem(vault, item.id).lastUsedAt, used, 'timestamp survived the save');
  equal(model.getItem(vault, item.id).password, 'new', 'the edit still applied');
});

test('publicSummary carries no secrets', () => {
  const item = model.newItem('login', { name: 'X', username: 'u', password: 'p', totp: 'JBSW' });
  const summary = model.publicSummary(item);
  const text = JSON.stringify(summary);
  assert(!text.includes('"p"') && !text.includes('JBSW'), 'summary leaked a secret');
  equal(summary.hasTotp, true, 'summary still reports that a code exists');
});

test('migrate upgrades bare string URIs', () => {
  const migrated = model.migrate({
    version: 0,
    items: [{ id: '1', type: 'login', uris: ['https://example.com'] }],
  });
  equal(migrated.items[0].uris, [{ uri: 'https://example.com', matchType: 'domain' }], 'uris');
  equal(
    Object.keys(migrated.settings).sort(),
    Object.keys(model.defaultSettings()).sort(),
    'every settings key is backfilled',
  );
});

test('migrate keeps settings the user has already chosen', () => {
  const migrated = model.migrate({ items: [], settings: { autoLockMinutes: 30 } });
  equal(migrated.settings.autoLockMinutes, 30, 'existing choice survives');
  equal(
    migrated.settings.clipboardClearSeconds,
    model.defaultSettings().clipboardClearSeconds,
    'missing keys take the default',
  );
});

// ------------------------------------------------------------------ matcher

test('lookalike domains never match', () => {
  const saved = { uri: 'paypal.com', matchType: 'domain' };
  assert(matcher.uriMatches(saved, 'https://www.paypal.com/signin'), 'subdomain should match');
  assert(!matcher.uriMatches(saved, 'https://evil-paypal.com/signin'), 'prefixed lookalike');
  assert(!matcher.uriMatches(saved, 'https://paypal.com.attacker.net/'), 'suffixed lookalike');
  assert(!matcher.uriMatches(saved, 'https://paypal.co/'), 'different TLD');
});

test('multi-part public suffixes resolve correctly', () => {
  equal(matcher.registrableDomain('https://mail.foo.co.uk/x'), 'foo.co.uk', 'co.uk');
  equal(matcher.registrableDomain('https://a.b.example.com'), 'example.com', 'plain com');
  equal(matcher.registrableDomain('https://alice.github.io'), 'alice.github.io', 'github pages');
  assert(
    !matcher.uriMatches({ uri: 'alice.github.io' }, 'https://bob.github.io/'),
    'two github pages users must stay separate',
  );
});

test('localhost and IP hosts match themselves only', () => {
  assert(matcher.uriMatches({ uri: 'http://localhost:3000' }, 'http://localhost:8080/x'), 'localhost');
  assert(matcher.uriMatches({ uri: '192.168.1.10' }, 'https://192.168.1.10/admin'), 'ip');
  assert(!matcher.uriMatches({ uri: '192.168.1.10' }, 'https://192.168.1.11/'), 'different ip');
});

test('match types narrow as expected', () => {
  const page = 'https://app.example.com/login?next=1';
  assert(matcher.uriMatches({ uri: 'https://example.com', matchType: 'domain' }, page), 'domain');
  assert(!matcher.uriMatches({ uri: 'https://example.com', matchType: 'host' }, page), 'host differs');
  assert(matcher.uriMatches({ uri: 'https://app.example.com', matchType: 'host' }, page), 'host equal');
  assert(matcher.uriMatches({ uri: 'https://app.example.com/log', matchType: 'startsWith' }, page), 'prefix');
  assert(!matcher.uriMatches({ uri: 'https://app.example.com', matchType: 'exact' }, page), 'exact differs');
  assert(!matcher.uriMatches({ uri: 'https://example.com', matchType: 'never' }, page), 'never');
});

test('exact host beats base domain in the ranking', () => {
  const base = model.newItem('login', {
    name: 'Base',
    uris: [{ uri: 'example.com', matchType: 'domain' }],
  });
  const exact = model.newItem('login', {
    name: 'Exact',
    uris: [{ uri: 'https://app.example.com', matchType: 'domain' }],
  });
  const ranked = matcher.rankMatches([base, exact], 'https://app.example.com/login');
  equal(ranked.map((item) => item.name), ['Exact', 'Base'], 'ranking order');
});

// ---------------------------------------------------------------------- csv

test('CSV parser handles quotes, commas and newlines', () => {
  const rows = csv.parseCsv('a,b\n"x,1","y\n2"\n');
  equal(rows.length, 2, 'row count');
  equal(rows[1], ['x,1', 'y\n2'], 'quoted fields');
  equal(csv.parseCsv('a,"say ""hi"""')[0], ['a', 'say "hi"'], 'escaped quotes');
});

test('the vault survives a CSV export and re-import', () => {
  const original = [
    model.newItem('login', {
      name: 'Example',
      folder: 'Dev',
      favorite: true,
      username: 'ada@example.com',
      password: 'pa,ss "quoted"',
      uris: [{ uri: 'https://example.com/login', matchType: 'domain' }],
      totp: 'JBSWY3DPEHPK3PXP',
      notes: 'line one\nline two',
    }),
    model.newItem('note', { name: 'Wi-Fi', notes: 'Key is on the router' }),
    model.newItem('card', {
      name: 'Everyday',
      cardholder: 'A Lovelace',
      number: '4111111111111111',
      expMonth: '04',
      expYear: '2029',
      cvv: '123',
    }),
  ];

  const analysis = csv.analyze(csv.itemsToCsv(original));
  assert(analysis.header, 'the exporter writes a header');
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);

  equal(items.length, 3, 'every item came back');
  equal(items.map((item) => item.type), ['login', 'note', 'card'], 'types preserved');
  equal(items[0].password, 'pa,ss "quoted"', 'awkward password preserved');
  equal(items[0].notes, 'line one\nline two', 'multi-line notes preserved');
  equal(items[0].favorite, true, 'favourite flag preserved');
  equal(items[0].totp, 'JBSWY3DPEHPK3PXP', 'totp preserved');
  equal(items[0].uris[0].uri, 'https://example.com/login', 'url preserved');
  equal(items[2].number, '4111111111111111', 'card number preserved');
  equal(items[2].cvv, '123', 'card code preserved');
});

test('the blank template imports as three example items', () => {
  const analysis = csv.analyze(csv.templateCsv());
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);
  equal(items.map((item) => item.type), ['login', 'note', 'card'], 'one of each type');
});

test('a foreign CSV maps by its headings', () => {
  const text = 'Title,Login,Secret,Web site,Category\nGitHub,ada,hunter2,https://github.com,Dev\n';
  const analysis = csv.analyze(text);
  assert(analysis.header, 'header detected');
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);
  equal(items[0].name, 'GitHub', 'title -> name');
  equal(items[0].username, 'ada', 'login -> username');
  equal(items[0].password, 'hunter2', 'secret -> password');
  equal(items[0].folder, 'Dev', 'category -> folder');
});

test('an unrecognised CSV is left for the user to map, not guessed', () => {
  const analysis = csv.analyze('ada,pw123,https://reddit.com\n');
  assert(analysis.header === null, 'no header claimed');
  equal(
    Object.values(analysis.mapping),
    [csv.IGNORED, csv.IGNORED, csv.IGNORED],
    'every column starts ignored',
  );
  equal(csv.rowsToItems(analysis.dataRows, analysis.mapping).items.length, 0, 'nothing imported');

  // ...and once mapped by hand, it imports.
  const mapping = { 0: 'username', 1: 'password', 2: 'url' };
  const { items } = csv.rowsToItems(analysis.dataRows, mapping);
  equal(items[0].username, 'ada', 'mapped username');
  equal(items[0].name, 'Reddit', 'name derived from the url');
});

test('a headerless file can be forced to import as data', () => {
  const analysis = csv.analyze('name,username\nGitHub,ada\n', { hasHeader: false });
  equal(analysis.dataRows.length, 2, 'the heading row counts as data when told to');
});

test('rows without credentials import as notes', () => {
  const analysis = csv.analyze('title,note\nWi-Fi,The key is on the router\n');
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);
  equal(items[0].type, 'note', 'type');
  equal(items[0].notes, 'The key is on the router', 'body');
});

test('import de-duplicates against what is already saved', () => {
  const existing = [
    model.newItem('login', {
      username: 'ada',
      uris: [{ uri: 'https://github.com/login', matchType: 'domain' }],
    }),
  ];
  const incoming = [
    model.newItem('login', {
      username: 'ada',
      uris: [{ uri: 'https://www.github.com/', matchType: 'domain' }],
    }),
    model.newItem('login', {
      username: 'bob',
      uris: [{ uri: 'https://github.com/', matchType: 'domain' }],
    }),
  ];
  const { fresh, duplicates } = csv.dedupeAgainst(existing, incoming);
  equal(duplicates.length, 1, 'same account skipped');
  equal(fresh.length, 1, 'different account kept');
});

test('CSV export escapes what it must', () => {
  const text = csv.itemsToCsv([model.newItem('login', { name: 'a,b', password: 'say "hi"' })]);
  assert(text.includes('"a,b"'), 'comma quoted');
  assert(text.includes('"say ""hi"""'), 'quote escaped');
});

// --------------------------------------------------------------------- totp

test('TOTP matches the RFC 6238 vectors', async () => {
  const secret = totp.asciiSecret('12345678901234567890');
  const vectors = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of vectors) {
    const code = await totp.generateTotp({ secret, digits: 8 }, seconds * 1000);
    equal(code, expected, `vector at t=${seconds}`);
  }
});

test('otpauth links and bare secrets both parse', () => {
  const parsed = totp.parseTotpInput('otpauth://totp/GitHub:ada?secret=JBSWY3DPEHPK3PXP&issuer=GitHub');
  equal(parsed.secret, 'JBSWY3DPEHPK3PXP', 'secret');
  equal(parsed.issuer, 'GitHub', 'issuer');
  equal(totp.parseTotpInput('jbsw y3dp ehpk 3pxp').secret, 'jbswy3dpehpk3pxp', 'spaces stripped');
});

test('a standalone code entry carries its own settings', () => {
  const item = model.newItem('totp', {
    name: 'Work VPN',
    username: 'ada',
    totp: 'JBSWY3DPEHPK3PXP',
    totpAlgorithm: 'SHA-256',
    totpDigits: 8,
    totpPeriod: 60,
  });
  equal(model.totpConfig(item), {
    secret: 'JBSWY3DPEHPK3PXP',
    algorithm: 'SHA-256',
    digits: 8,
    period: 60,
  }, 'config read back');
  equal(model.isDefaultTotpConfig(item), false, 'recognised as non-default');
  equal(model.hasTotp(item), true, 'has a code');

  const plain = model.newItem('totp', { totp: 'JBSWY3DPEHPK3PXP' });
  equal(model.isDefaultTotpConfig(plain), true, 'defaults recognised');
  equal(model.totpConfig(plain).digits, 6, 'default digits');
});

test('a non-default code survives CSV export and re-import', () => {
  const original = model.newItem('totp', {
    name: 'Work VPN',
    username: 'ada@example.com',
    totp: 'JBSWY3DPEHPK3PXP',
    totpAlgorithm: 'SHA-256',
    totpDigits: 8,
    totpPeriod: 60,
  });

  const text = csv.itemsToCsv([original]);
  assert(text.includes('otpauth://'), 'non-default settings go out as a full link');

  const analysis = csv.analyze(text);
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);
  equal(items[0].type, 'totp', 'still a code entry');
  equal(items[0].totp, 'JBSWY3DPEHPK3PXP', 'secret');
  equal(items[0].totpAlgorithm, 'SHA-256', 'algorithm');
  equal(items[0].totpDigits, 8, 'digits');
  equal(items[0].totpPeriod, 60, 'period');
  equal(items[0].username, 'ada@example.com', 'account');
});

test('a default code still exports as a bare secret', () => {
  const item = model.newItem('login', { name: 'GitHub', totp: 'JBSWY3DPEHPK3PXP' });
  const text = csv.itemsToCsv([item]);
  assert(!text.includes('otpauth://'), 'no need for a link when nothing is custom');
  const analysis = csv.analyze(text);
  const { items } = csv.rowsToItems(analysis.dataRows, analysis.mapping);
  equal(items[0].totp, 'JBSWY3DPEHPK3PXP', 'secret round-trips');
});

test('a paste of otpauth links imports as codes', () => {
  const text = [
    'otpauth://totp/GitHub:ada@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub',
    'otpauth://totp/Work?secret=GEZDGNBVGY3TQOJQ&algorithm=SHA256&digits=8&period=60',
    'not a link at all',
  ].join('\n');
  const { entries, problems } = totp.parseAuthenticatorExport(text);
  equal(entries.length, 2, 'two codes read');
  equal(entries[0].issuer, 'GitHub', 'issuer');
  equal(entries[0].account, 'ada@example.com', 'account');
  equal(entries[1].algorithm, 'SHA-256', 'algorithm normalised');
  equal(entries[1].digits, 8, 'digits');
  equal(entries[1].period, 60, 'period');
  equal(problems.length, 1, 'the junk line is reported, not silently dropped');
});

test('a JSON export from another authenticator imports too', () => {
  const text = JSON.stringify([
    { secret: 'JBSWY3DPEHPK3PXP', issuer: 'GitHub', account: 'ada' },
    { secret: 'GEZDGNBVGY3TQOJQ', name: 'Bank:ada@example.com' },
    { issuer: 'Broken', account: 'no secret here' },
  ]);
  const { entries, problems } = totp.parseAuthenticatorExport(text);
  equal(entries.length, 2, 'two usable entries');
  equal(entries[1].issuer, 'Bank', 'issuer split out of a combined label');
  equal(entries[1].account, 'ada@example.com', 'account split out');
  equal(problems.length, 1, 'the entry with no secret is reported');
});

test('migration links are refused with an explanation, not ignored', () => {
  const { entries, problems } = totp.parseAuthenticatorExport(
    'otpauth-migration://offline?data=AAAA',
  );
  equal(entries.length, 0, 'nothing imported');
  assert(problems[0].includes('otpauth-migration'), 'says why');
});

test('standalone code entries can match a site, notes and cards cannot', () => {
  const code = model.newItem('totp', {
    name: 'GitHub',
    uris: [{ uri: 'github.com', matchType: 'domain' }],
  });
  const note = model.newItem('note', {
    name: 'GitHub',
    uris: [{ uri: 'github.com', matchType: 'domain' }],
  });
  assert(matcher.itemMatches(code, 'https://github.com/login'), 'code entry matches');
  assert(!matcher.itemMatches(note, 'https://github.com/login'), 'note never matches');
  equal(matcher.rankMatches([code, note], 'https://github.com/login').length, 1, 'only the code');
});

test('a bad base32 secret is reported, not guessed at', () => {
  let threw = false;
  try {
    totp.base32Decode('not-base32!!');
  } catch {
    threw = true;
  }
  assert(threw, 'invalid base32 should throw');
});

// ---------------------------------------------------------------- generator

test('generated passwords honour every enabled class', () => {
  for (let i = 0; i < 300; i++) {
    const password = generator.generatePassword({ length: 8 });
    equal(password.length, 8, 'length');
    assert(/[a-z]/.test(password), 'lowercase present');
    assert(/[A-Z]/.test(password), 'uppercase present');
    assert(/[0-9]/.test(password), 'digit present');
    assert(/[^A-Za-z0-9]/.test(password), 'symbol present');
  }
});

test('excluding look-alikes really excludes them', () => {
  for (let i = 0; i < 200; i++) {
    const password = generator.generatePassword({ length: 24, excludeAmbiguous: true });
    assert(!/[Il1O0oB8S5Z2G6q9gy]/.test(password), `found an ambiguous character in ${password}`);
  }
});

test('turning every class off still yields a password', () => {
  const password = generator.generatePassword({
    length: 12,
    lower: false,
    upper: false,
    digits: false,
    symbols: false,
  });
  equal(password.length, 12, 'still 12 characters');
});

test('randomInt is unbiased across its range', () => {
  const buckets = new Array(7).fill(0);
  const draws = 21000;
  for (let i = 0; i < draws; i++) buckets[generator.randomInt(7)]++;
  const expected = draws / 7;
  for (const count of buckets) {
    assert(Math.abs(count - expected) < expected * 0.15, `bucket skew: ${buckets.join(',')}`);
  }
});

test('passphrases use the whole wordlist', () => {
  const phrase = generator.generatePassphrase({ words: 4, separator: '-' });
  equal(phrase.split('-').length, 4, 'word count');
  assert(generator.WORD_COUNT > 2000, `wordlist too small: ${generator.WORD_COUNT}`);
  assert(generator.passphraseEntropyBits({ words: 5 }) >= 55, 'five words should clear 55 bits');
});

// ----------------------------------------------------------------- qr codes

// Paint a module matrix into an ImageData-shaped object so the whole image
// pipeline can be exercised, optionally rotated, offset, or low contrast.
function renderQr(rows, options = {}) {
  const { scale = 5, pad = 40, turns = 0, dark = 0, light = 255, width, height } = options;
  const modules = rows.length;
  const drawn = modules * scale;
  const imageWidth = width || drawn + pad * 2;
  const imageHeight = height || drawn + pad * 2;

  const data = new Uint8ClampedArray(imageWidth * imageHeight * 4).fill(light);
  for (let i = 3; i < data.length; i += 4) data[i] = 255;

  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      let rx = mx;
      let ry = my;
      for (let turn = 0; turn < turns; turn++) {
        const nx = modules - 1 - ry;
        ry = rx;
        rx = nx;
      }
      const value = rows[my][mx] === '1' ? dark : light;
      for (let py = 0; py < scale; py++) {
        for (let px = 0; px < scale; px++) {
          const x = pad + rx * scale + px;
          const y = pad + ry * scale + py;
          if (x >= imageWidth || y >= imageHeight) continue;
          const offset = (y * imageWidth + x) * 4;
          data[offset] = value;
          data[offset + 1] = value;
          data[offset + 2] = value;
        }
      }
    }
  }
  return { data, width: imageWidth, height: imageHeight };
}

test('the block tables agree with the codeword count for every version', () => {
  // Re-derive the codeword count from the geometry rather than trusting the
  // constant, then check all 40 block rows add up to it. A single mistyped digit
  // in those tables would decode as silent corruption, so this is the guard.
  for (let version = 1; version <= qr.MAX_VERSION; version++) {
    const dimension = version * 4 + 17;
    const centres = qr.alignmentCount(version);
    const alignmentModules = centres ? 25 * (centres * centres - 3) - 10 * (centres - 2) : 0;
    const functionModules =
      192 + // three finders with their separators
      31 + // format information and the dark module
      (version >= 7 ? 36 : 0) + // version information
      2 * (dimension - 16) + // the two timing patterns
      alignmentModules;
    const derived = Math.floor((dimension * dimension - functionModules) / 8);
    equal(qr.totalCodewords(version), derived, `version ${version} codeword count`);

    for (const level of ['L', 'M', 'Q', 'H']) {
      const total = qr.blockLayout(version, level).reduce(
        (sum, block) => sum + block.data + block.ec,
        0,
      );
      equal(total, derived, `version ${version} level ${level} blocks`);
    }
  }
});

test('real QR symbols decode from their module grids', () => {
  for (const fixture of QR_FIXTURES) {
    const { matrix, dimension } = fixtureMatrix(fixture.matrix);
    equal(qr.decodeMatrix(matrix, dimension), fixture.expected, fixture.name);
  }
});

test('real QR symbols decode from an image', () => {
  for (const fixture of QR_FIXTURES) {
    for (const scale of [3, 5, 9]) {
      const image = renderQr(fixture.matrix, { scale });
      equal(qr.decodeImageData(image), fixture.expected, `${fixture.name} at ${scale}px`);
    }
  }
});

test('a QR code decodes whichever way up it is', () => {
  const fixture = QR_FIXTURES[2];
  for (const turns of [0, 1, 2, 3]) {
    const image = renderQr(fixture.matrix, { scale: 5, turns });
    equal(qr.decodeImageData(image), fixture.expected, `rotated ${turns * 90} degrees`);
  }
});

test('a QR code is found off-centre in a large image', () => {
  const fixture = QR_FIXTURES[1];
  const image = renderQr(fixture.matrix, { scale: 6, pad: 300, width: 900, height: 700 });
  equal(qr.decodeImageData(image), fixture.expected, 'found in the corner of a page');
});

test('a low-contrast screenshot still decodes', () => {
  const fixture = QR_FIXTURES[0];
  const image = renderQr(fixture.matrix, { scale: 6, dark: 60, light: 235 });
  equal(qr.decodeImageData(image), fixture.expected, 'grey on off-white');
});

test('an encoded QR reads back as what went in', () => {
  // The decoder is validated against real symbols above, so round-tripping
  // through it is a genuine check on the encoder rather than a circular one.
  const payloads = [
    'HELLO',
    'otpauth://totp/Example:demo@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example',
    'otpauth://totp/Work:ada@example.com?secret=GEZDGNBVGY3TQOJQ&issuer=Work&algorithm=SHA256&digits=8&period=45',
  ];
  for (const text of payloads) {
    for (const level of ['L', 'M', 'Q', 'H']) {
      // Only levels that can hold it; a long link at H needs a bigger symbol
      // than this decoder handles.
      let encoded;
      try {
        encoded = qr.encodeMatrix(text, level);
      } catch {
        continue;
      }
      equal(
        qr.decodeMatrix(encoded.matrix, encoded.dimension),
        text,
        `${level}, version ${encoded.version}`,
      );
    }
  }
});

test('an encoded QR survives being drawn and read back as an image', () => {
  const text = 'otpauth://totp/Example:demo@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example';
  const { matrix, dimension } = qr.encodeMatrix(text);
  const rows = [];
  for (let y = 0; y < dimension; y++) {
    let row = '';
    for (let x = 0; x < dimension; x++) row += matrix[y * dimension + x] ? '1' : '0';
    rows.push(row);
  }
  equal(qr.decodeImageData(renderQr(rows, { scale: 4 })), text, 'through the image pipeline');
});

test('encoding picks the smallest symbol that fits, dropping error level only when it must', () => {
  const short = qr.encodeMatrix('HELLO');
  equal(short.version, 1, 'a short payload fits version 1');
  equal(short.ecLevel, 'M', 'and keeps the higher error level');

  const long = qr.encodeMatrix('x'.repeat(260));
  equal(long.ecLevel, 'L', 'a long payload drops to L rather than failing');

  let message = '';
  try {
    qr.encodeMatrix('x'.repeat(400));
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('too long'), `expected a clear refusal, got "${message}"`);
});

test('an image with no QR code says so rather than returning nonsense', () => {
  const blank = renderQr(['0'], { scale: 1, pad: 60 });
  let message = '';
  try {
    qr.decodeImageData(blank);
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('No QR code'), `expected a clear message, got "${message}"`);
});

test('a symbol larger than the supported range is reported, not misread', () => {
  const dimension = 21 + 4 * 12; // version 13
  const matrix = new Uint8Array(dimension * dimension);
  let message = '';
  try {
    qr.decodeMatrix(matrix, dimension);
  } catch (error) {
    message = error.message;
  }
  assert(message.includes('version 13'), `expected the version in the message, got "${message}"`);
});

// --------------------------------------------------------------------- sync

const SYNC_CONFIG = { apiKey: 'test-key', projectId: 'vault-test' };
const SYNC_SESSION = { uid: 'user-1', idToken: 'token-1' };

// A stub standing in for the network: it records what was asked and replies with
// something canned, so the shape of the request is what is under test.
function stubFetch(replies) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request to ' + url);
    return {
      ok: reply.status === undefined || reply.status < 400,
      status: reply.status || 200,
      text: async () => (reply.body === undefined ? '' : JSON.stringify(reply.body)),
    };
  };
  return { fetchImpl, calls };
}

test('sync writes to the signed-in account document only', async () => {
  const { fetchImpl, calls } = stubFetch([{ body: {} }]);
  await sync.pushRemote(
    SYNC_CONFIG,
    SYNC_SESSION,
    { blob: { v: 1, ct: 'cipher' }, revision: 4, updatedAt: '2026-01-01T00:00:00.000Z', device: 'Windows' },
    fetchImpl,
  );

  const [call] = calls;
  assert(call.url.endsWith('/documents/vaults/user-1'), 'wrote somewhere else: ' + call.url);
  equal(call.options.headers.authorization, 'Bearer token-1', 'sent the id token');

  const sent = JSON.parse(call.options.body);
  equal(sent.fields.revision.integerValue, '4', 'revision travelled');
  equal(JSON.parse(sent.fields.blob.stringValue).ct, 'cipher', 'the blob travelled verbatim');
});

test('sync uploads ciphertext and nothing else', async () => {
  const vault = model.emptyVault();
  vault.items.push(model.newItem('login', { name: 'GitHub', username: 'ada', password: 'hunter2' }));
  const { blob } = await vaultCrypto.create(vault, 'correct horse battery staple');

  const { fetchImpl, calls } = stubFetch([{ body: {} }]);
  await sync.pushRemote(SYNC_CONFIG, SYNC_SESSION, { blob, revision: 1, updatedAt: '', device: '' }, fetchImpl);

  const body = calls[0].options.body;
  for (const secret of ['hunter2', 'ada', 'GitHub']) {
    assert(!body.includes(secret), secret + ' left the machine in the sync payload');
  }
});

test('sync reads a document back into a blob', async () => {
  const { fetchImpl } = stubFetch([
    {
      body: {
        fields: {
          blob: { stringValue: '{"v":1,"ct":"cipher"}' },
          revision: { integerValue: '7' },
          updatedAt: { stringValue: '2026-01-02T03:04:05.000Z' },
          device: { stringValue: 'Mac (Chrome)' },
        },
      },
    },
  ]);
  const remote = await sync.fetchRemote(SYNC_CONFIG, SYNC_SESSION, fetchImpl);
  equal(remote.revision, 7, 'revision parsed');
  equal(remote.blob.ct, 'cipher', 'blob parsed');
  equal(remote.device, 'Mac (Chrome)', 'device parsed');
});

test('sync treats a missing document as an empty server, not an error', async () => {
  const { fetchImpl } = stubFetch([{ status: 404, body: { error: { message: 'NOT_FOUND' } } }]);
  equal(await sync.fetchRemote(SYNC_CONFIG, SYNC_SESSION, fetchImpl), null, 'no document yet');
});

test('sync turns a Firebase error code into something readable', async () => {
  const { fetchImpl } = stubFetch([{ status: 400, body: { error: { message: 'INVALID_PASSWORD' } } }]);
  let message = '';
  try {
    await sync.signIn(SYNC_CONFIG, 'ada@example.com', 'wrong', fetchImpl);
  } catch (error) {
    message = error.message;
  }
  equal(message, 'Wrong sync password.', 'explained the failure');
});

test('sync decides which way each case goes', () => {
  const remote = (revision) => ({ revision, blob: {}, updatedAt: '', device: '' });

  equal(sync.decideSync({ revision: 0, dirty: true }, null), 'push', 'seeds an empty server');
  equal(sync.decideSync({ revision: 3, dirty: false }, remote(3)), 'none', 'nothing to do');
  equal(sync.decideSync({ revision: 3, dirty: true }, remote(3)), 'push', 'local edits go up');
  equal(sync.decideSync({ revision: 3, dirty: false }, remote(5)), 'pull', 'their edits come down');
  // The case that matters: both sides moved, so neither is thrown away silently.
  equal(sync.decideSync({ revision: 3, dirty: true }, remote(5)), 'conflict', 'both sides moved');
  equal(sync.decideSync({ revision: 5, dirty: false }, remote(3)), 'push', 'a lost push is retried');

  equal(sync.nextRevision(null), 1, 'first upload is revision 1');
  equal(sync.nextRevision(remote(9)), 10, 'revisions increase');
});

test('sync reads the two values it needs out of a pasted Firebase config', () => {
  const snippet = [
    'const firebaseConfig = {',
    '  apiKey: "AIzaSyExample-key_1234",',
    '  authDomain: "my-vault-1a2b3.firebaseapp.com",',
    '  projectId: "my-vault-1a2b3",',
    '  storageBucket: "my-vault-1a2b3.appspot.com",',
    '};',
  ].join('\n');
  equal(sync.parseFirebaseConfig(snippet), { apiKey: 'AIzaSyExample-key_1234', projectId: 'my-vault-1a2b3' }, 'read the snippet');

  // Older consoles print a config with no projectId; the domain carries it.
  const older = '{ "apiKey": "AIzaOld", "authDomain": "legacy-vault.firebaseapp.com" }';
  equal(sync.parseFirebaseConfig(older).projectId, 'legacy-vault', 'fell back to the domain');
  equal(sync.parseFirebaseConfig('nothing useful here'), { apiKey: '', projectId: '' }, 'nothing to read');
});

export async function runSuite() {
  const results = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      results.push({ name, ok: true });
    } catch (error) {
      results.push({ name, ok: false, message: error.message });
    }
  }
  return results;
}
