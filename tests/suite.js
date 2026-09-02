// One suite, two runners: `node tests/run.mjs` for the command line and
// tests/test.html in the browser. Everything here is pure library code, so both
// see identical results.

import * as vaultCrypto from '../src/lib/crypto.js';
import * as model from '../src/lib/vault.js';
import * as matcher from '../src/lib/matcher.js';
import * as csv from '../src/lib/csv.js';
import * as totp from '../src/lib/totp.js';
import * as generator from '../src/lib/generator.js';

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
  const flipped = { ...blob, ct: 'A' + blob.ct.slice(1) };
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
