// Builds the ZIP to upload to the Chrome Web Store.
//   node tools/package.js
//
// Only what the extension actually runs goes in: manifest.json, src/ and icons/.
// Tests, tooling, the README and anything untracked stay out, and the signing key
// is refused outright -- a .pem inside the upload would hand over the extension.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const INCLUDE = ['manifest.json', 'src', 'icons'];
const REFUSE = /\.(pem|key|crx|zip)$/i;

// --- collect ---------------------------------------------------------------

function collect(relative, files = []) {
  const absolute = path.join(ROOT, relative);
  const stats = fs.statSync(absolute);
  if (stats.isDirectory()) {
    for (const entry of fs.readdirSync(absolute).sort()) {
      collect(path.posix.join(relative.split(path.sep).join('/'), entry), files);
    }
  } else {
    if (REFUSE.test(relative)) {
      throw new Error(`Refusing to package ${relative} -- keys and archives must not ship.`);
    }
    files.push({ name: relative.split(path.sep).join('/'), data: fs.readFileSync(absolute) });
  }
  return files;
}

// --- zip -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

// Fixed 1980-01-01 stamp so the same sources always produce the same bytes.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const compressed = zlib.deflateRawSync(file.data, { level: 9 });
    const checksum = crc32(file.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(8, 8); // deflate
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(file.data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    locals.push(localHeader, name, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(file.data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra
    centralHeader.writeUInt16LE(0, 32); // comment
    centralHeader.writeUInt16LE(0, 34); // disk
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);

    offset += localHeader.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

// --- checks the store would fail you for -----------------------------------

function preflight(manifest, files) {
  const problems = [];

  if (!manifest.name) problems.push('manifest has no name');
  if (!/^\d+(\.\d+){0,3}$/.test(manifest.version || '')) {
    problems.push(`version "${manifest.version}" is not a valid store version string`);
  }
  if (!manifest.description) problems.push('manifest has no description');
  else if (manifest.description.length > 132) {
    problems.push(`description is ${manifest.description.length} characters; the store allows 132`);
  }
  if (!manifest.icons || !manifest.icons['128']) problems.push('no 128px icon');

  const names = new Set(files.map((file) => file.name));
  if (!names.has('manifest.json')) problems.push('manifest.json must sit at the root of the zip');
  for (const icon of Object.values(manifest.icons || {})) {
    if (!names.has(icon)) problems.push(`icon missing from the package: ${icon}`);
  }

  return problems;
}

// --- run -------------------------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const files = INCLUDE.flatMap((entry) => collect(entry));
const problems = preflight(manifest, files);

if (problems.length) {
  console.error('Not packaged. Fix these first:');
  for (const problem of problems) console.error('  - ' + problem);
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const target = path.join(OUT_DIR, `keyring-${manifest.version}.zip`);
fs.writeFileSync(target, buildZip(files));

const kb = (fs.statSync(target).size / 1024).toFixed(1);
console.log(`${files.length} files, ${kb} KB`);
console.log('wrote ' + path.relative(process.cwd(), target));
console.log('\nUpload this at https://chrome.google.com/webstore/devconsole');
console.log('Listing copy and permission justifications: store/listing.md');
