// A QR decoder, written here rather than pulled in, so a password manager does
// not ship a third-party blob it has never read.
//
// Chrome only exposes BarcodeDetector on Android, macOS and ChromeOS, so on
// Windows there is nothing native to lean on.
//
// The pipeline: binarize the image, find the three finder patterns, sample the
// module grid, read the format information, undo the data mask, walk the
// codewords in their zigzag order, repair them with Reed-Solomon, then decode the
// bit stream.
//
// Scope: versions 1 to 10 (21x21 up to 57x57). Every otpauth:// link fits well
// inside that -- version 10 at error level L holds 274 bytes -- and each extra
// version is another row of block tables to get right for no practical gain.
// Bigger symbols are reported rather than mis-decoded.

export const MAX_VERSION = 10;

// ---------------------------------------------------------------- tables

// Total codewords (data + error correction) per version. Derived from the module
// count; tests re-derive these geometrically rather than trusting the list.
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];

// Per version and error-correction level: error-correction codewords per block,
// then the block groups as [count, data codewords per block].
// The invariant that catches a typo: the codewords implied here must equal
// TOTAL_CODEWORDS for that version, which the test suite checks for all 40 rows.
const BLOCKS = {
  L: [
    [7, [[1, 19]]],
    [10, [[1, 34]]],
    [15, [[1, 55]]],
    [20, [[1, 80]]],
    [26, [[1, 108]]],
    [18, [[2, 68]]],
    [20, [[2, 78]]],
    [24, [[2, 97]]],
    [30, [[2, 116]]],
    [18, [[2, 68], [2, 69]]],
  ],
  M: [
    [10, [[1, 16]]],
    [16, [[1, 28]]],
    [26, [[1, 44]]],
    [18, [[2, 32]]],
    [24, [[2, 43]]],
    [16, [[4, 27]]],
    [18, [[4, 31]]],
    [22, [[2, 38], [2, 39]]],
    [22, [[3, 36], [2, 37]]],
    [26, [[4, 43], [1, 44]]],
  ],
  Q: [
    [13, [[1, 13]]],
    [22, [[1, 22]]],
    [18, [[2, 17]]],
    [26, [[2, 24]]],
    [18, [[2, 15], [2, 16]]],
    [24, [[4, 19]]],
    [18, [[2, 14], [4, 15]]],
    [22, [[4, 18], [2, 19]]],
    [20, [[4, 16], [4, 17]]],
    [24, [[6, 19], [2, 20]]],
  ],
  H: [
    [17, [[1, 9]]],
    [28, [[1, 16]]],
    [22, [[2, 13]]],
    [16, [[4, 9]]],
    [22, [[2, 11], [2, 12]]],
    [28, [[4, 15]]],
    [26, [[4, 13], [1, 14]]],
    [26, [[4, 14], [2, 15]]],
    [24, [[4, 12], [4, 13]]],
    [28, [[6, 15], [2, 16]]],
  ],
};

// Format information encodes the level in this order, not L/M/Q/H.
const EC_LEVELS = ['M', 'L', 'H', 'Q'];

// Alignment pattern centre coordinates, versions 2 to 10.
const ALIGNMENT = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// The eight data masks, by pattern number. True means the module is flipped.
const MASKS = [
  (row, column) => (row + column) % 2 === 0,
  (row) => row % 2 === 0,
  (row, column) => column % 3 === 0,
  (row, column) => (row + column) % 3 === 0,
  (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
  (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
  (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
  (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
];

export function alignmentCount(version) {
  return (ALIGNMENT[version - 1] || []).length;
}

// The blocks a symbol is split into, as {data, ec} codeword counts. Exported so
// the tests can check the tables add up to the codeword count the geometry
// implies -- a mistyped digit here would corrupt data silently.
export function blockLayout(version, ecLevel) {
  const [ecPerBlock, groups] = BLOCKS[ecLevel][version - 1];
  const blocks = [];
  for (const [count, dataCodewords] of groups) {
    for (let i = 0; i < count; i++) blocks.push({ data: dataCodewords, ec: ecPerBlock });
  }
  return blocks;
}

export function totalCodewords(version) {
  return TOTAL_CODEWORDS[version - 1];
}

// ------------------------------------------------------- GF(256) arithmetic

// The QR field: x^8 + x^4 + x^3 + x^2 + 1.
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function gfMultiply(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

function gfDivide(a, b) {
  if (b === 0) throw new Error('divide by zero in GF(256)');
  if (a === 0) return 0;
  return EXP[(LOG[a] + 255 - LOG[b]) % 255];
}

function polyMultiply(a, b) {
  const result = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === 0) continue;
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMultiply(a[i], b[j]);
    }
  }
  return result;
}

function polyEvaluate(poly, x) {
  let result = 0;
  for (const coefficient of poly) result = gfMultiply(result, x) ^ coefficient;
  return result;
}

// ------------------------------------------------- Reed-Solomon correction

// Berlekamp-Massey, then Chien search and Forney. Coefficients run
// highest-degree first, matching the codeword order on the symbol.
function correctBlock(bytes, ecCount) {
  const syndromes = new Uint8Array(ecCount);
  let hasError = false;
  for (let i = 0; i < ecCount; i++) {
    syndromes[i] = polyEvaluate(bytes, EXP[i]);
    if (syndromes[i] !== 0) hasError = true;
  }
  if (!hasError) return bytes.slice(0, bytes.length - ecCount);

  // Syndrome polynomial, lowest degree last.
  const syndromePoly = new Uint8Array(ecCount);
  for (let i = 0; i < ecCount; i++) syndromePoly[ecCount - 1 - i] = syndromes[i];

  let errorLocator = Uint8Array.from([1]);
  let previous = Uint8Array.from([1]);
  let discrepancyPrevious = 1;
  let shift = 1;

  for (let round = 0; round < ecCount; round++) {
    let discrepancy = syndromes[round];
    for (let i = 1; i < errorLocator.length; i++) {
      discrepancy ^= gfMultiply(errorLocator[errorLocator.length - 1 - i], syndromes[round - i]);
    }

    if (discrepancy === 0) {
      shift += 1;
      continue;
    }

    const scale = gfDivide(discrepancy, discrepancyPrevious);
    const shifted = new Uint8Array(previous.length + shift);
    shifted.set(previous, 0);
    const scaled = shifted.map((value) => gfMultiply(value, scale));

    const next = new Uint8Array(Math.max(errorLocator.length, scaled.length));
    next.set(errorLocator, next.length - errorLocator.length);
    for (let i = 0; i < scaled.length; i++) {
      next[next.length - scaled.length + i] ^= scaled[i];
    }

    if (2 * (errorLocator.length - 1) <= round) {
      previous = errorLocator;
      discrepancyPrevious = discrepancy;
      shift = 1;
    } else {
      shift += 1;
    }
    errorLocator = next;
  }

  const errorCount = errorLocator.length - 1;
  if (errorCount * 2 > ecCount) throw new Error('too many errors to correct');

  // Chien search: the roots of the locator point at the damaged positions.
  const positions = [];
  for (let i = 0; i < 255 && positions.length < errorCount; i++) {
    if (polyEvaluate(errorLocator, EXP[i]) === 0) {
      positions.push(255 - i);
    }
  }
  if (positions.length !== errorCount) throw new Error('could not locate the errors');

  // Forney: evaluate the magnitude at each position.
  const errorEvaluator = polyMultiply(errorLocator, syndromePoly).slice(-ecCount);
  const derivative = [];
  for (let i = 0; i < errorLocator.length; i++) {
    const degree = errorLocator.length - 1 - i;
    if (degree % 2 === 1) derivative.push(errorLocator[i]);
  }

  const corrected = Uint8Array.from(bytes);
  for (const position of positions) {
    const index = bytes.length - 1 - ((255 - position) % 255);
    if (index < 0 || index >= bytes.length) throw new Error('error position out of range');
    const xInverse = EXP[position % 255];
    const numerator = polyEvaluate(errorEvaluator, xInverse);
    const denominator = polyEvaluate(Uint8Array.from(derivative), gfMultiply(xInverse, xInverse));
    if (denominator === 0) throw new Error('error magnitude could not be computed');
    const magnitude = gfMultiply(xInverse, gfDivide(numerator, denominator));
    corrected[index] ^= magnitude;
  }

  // Verify: a corrected block has zero syndromes.
  for (let i = 0; i < ecCount; i++) {
    if (polyEvaluate(corrected, EXP[i]) !== 0) throw new Error('correction did not converge');
  }
  return corrected.slice(0, corrected.length - ecCount);
}

// ------------------------------------------------------- module bookkeeping

function dimensionFor(version) {
  return version * 4 + 17;
}

export function versionFor(dimension) {
  if ((dimension - 17) % 4 !== 0) return 0;
  return (dimension - 17) / 4;
}

// Which modules carry no data: finders, separators, timing, alignment, format
// and version areas.
function functionMap(version) {
  const dimension = dimensionFor(version);
  const map = new Uint8Array(dimension * dimension);
  const mark = (x, y, width, height) => {
    for (let dy = 0; dy < height; dy++) {
      for (let dx = 0; dx < width; dx++) {
        const px = x + dx;
        const py = y + dy;
        if (px >= 0 && py >= 0 && px < dimension && py < dimension) map[py * dimension + px] = 1;
      }
    }
  };

  // Finder patterns with their separators, and the format information beside them.
  mark(0, 0, 9, 9);
  mark(dimension - 8, 0, 8, 9);
  mark(0, dimension - 8, 9, 8);

  // Timing patterns.
  mark(6, 9, 1, dimension - 17);
  mark(9, 6, dimension - 17, 1);

  // Alignment patterns, except where they would sit on a finder.
  const centres = ALIGNMENT[version - 1] || [];
  for (const y of centres) {
    for (const x of centres) {
      const onFinder =
        (x === 6 && y === 6) ||
        (x === 6 && y === dimension - 7) ||
        (x === dimension - 7 && y === 6);
      if (!onFinder) mark(x - 2, y - 2, 5, 5);
    }
  }

  // Version information blocks, version 7 and up.
  if (version >= 7) {
    mark(dimension - 11, 0, 3, 6);
    mark(0, dimension - 11, 6, 3);
  }
  return map;
}

// The 32 valid format strings, so a read can be matched to the nearest one
// instead of implementing a BCH decoder.
const FORMAT_STRINGS = (() => {
  const strings = [];
  for (let data = 0; data < 32; data++) {
    let value = data << 10;
    for (let i = 4; i >= 0; i--) {
      if (value & (1 << (i + 10))) value ^= 0x537 << i;
    }
    strings.push({ data, bits: ((data << 10) | value) ^ 0x5412 });
  }
  return strings;
})();

function hammingDistance(a, b) {
  let difference = a ^ b;
  let count = 0;
  while (difference) {
    count += difference & 1;
    difference >>= 1;
  }
  return count;
}

function readFormat(matrix, dimension) {
  const at = (x, y) => matrix[y * dimension + x];

  // Two copies are written; try both and take the better match. The order below
  // is the one in the spec: along row 8 first, hopping the timing module, then up
  // column 8. Getting these two axes the wrong way round still yields a plausible
  // format, which is exactly why it is worth spelling out.
  let copyOne = 0;
  for (let column = 0; column <= 5; column++) copyOne = (copyOne << 1) | at(column, 8);
  copyOne = (copyOne << 1) | at(7, 8);
  copyOne = (copyOne << 1) | at(8, 8);
  copyOne = (copyOne << 1) | at(8, 7);
  for (let row = 5; row >= 0; row--) copyOne = (copyOne << 1) | at(8, row);

  let copyTwo = 0;
  for (let row = dimension - 1; row >= dimension - 7; row--) {
    copyTwo = (copyTwo << 1) | at(8, row);
  }
  for (let column = dimension - 8; column < dimension; column++) {
    copyTwo = (copyTwo << 1) | at(column, 8);
  }

  let best = null;
  for (const candidate of [copyOne, copyTwo]) {
    for (const format of FORMAT_STRINGS) {
      const distance = hammingDistance(candidate, format.bits);
      if (!best || distance < best.distance) best = { distance, data: format.data };
    }
  }
  if (!best || best.distance > 3) throw new Error('the format information could not be read');

  return {
    ecLevel: EC_LEVELS[(best.data >> 3) & 3],
    mask: best.data & 7,
  };
}

// Walk the symbol in its zigzag order and pull out the codewords.
function readCodewords(matrix, version, mask) {
  const dimension = dimensionFor(version);
  const functions = functionMap(version);
  const maskFn = MASKS[mask];
  const bytes = new Uint8Array(totalCodewords(version));

  let bitIndex = 0;
  let upward = true;

  for (let right = dimension - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern and is skipped entirely.
    if (right === 6) right = 5;
    for (let step = 0; step < dimension; step++) {
      const y = upward ? dimension - 1 - step : step;
      for (let column = 0; column < 2; column++) {
        const x = right - column;
        if (functions[y * dimension + x]) continue;
        const bit = matrix[y * dimension + x] ^ (maskFn(y, x) ? 1 : 0);
        if (bitIndex < bytes.length * 8) {
          bytes[bitIndex >> 3] |= bit << (7 - (bitIndex & 7));
        }
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
  return bytes;
}

// Undo the interleaving, correct each block, then concatenate the data.
function correctCodewords(bytes, version, ecLevel) {
  const [ecPerBlock, groups] = BLOCKS[ecLevel][version - 1];

  const blockSizes = [];
  for (const [count, dataCodewords] of groups) {
    for (let i = 0; i < count; i++) blockSizes.push(dataCodewords);
  }

  const blocks = blockSizes.map((size) => ({ data: new Uint8Array(size), ec: new Uint8Array(ecPerBlock) }));
  const longest = Math.max(...blockSizes);

  let index = 0;
  for (let position = 0; position < longest; position++) {
    for (let block = 0; block < blocks.length; block++) {
      if (position < blockSizes[block]) blocks[block].data[position] = bytes[index++];
    }
  }
  for (let position = 0; position < ecPerBlock; position++) {
    for (let block = 0; block < blocks.length; block++) {
      blocks[block].ec[position] = bytes[index++];
    }
  }

  const output = [];
  for (const block of blocks) {
    const combined = new Uint8Array(block.data.length + block.ec.length);
    combined.set(block.data, 0);
    combined.set(block.ec, block.data.length);
    output.push(...correctBlock(combined, ecPerBlock));
  }
  return Uint8Array.from(output);
}

// ------------------------------------------------------------- bit stream

const ALPHANUMERIC = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function decodeBitstream(bytes, version) {
  let bitPosition = 0;
  const totalBits = bytes.length * 8;

  const read = (count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      if (bitPosition >= totalBits) throw new Error('the data ended unexpectedly');
      const bit = (bytes[bitPosition >> 3] >> (7 - (bitPosition & 7))) & 1;
      value = (value << 1) | bit;
      bitPosition += 1;
    }
    return value;
  };

  // Character-count width depends on the version band; every version handled here
  // is in the first band.
  const countBits = (mode) => {
    if (version <= 9) return { numeric: 10, alphanumeric: 9, byte: 8 }[mode];
    return { numeric: 12, alphanumeric: 11, byte: 16 }[mode];
  };

  const out = [];
  while (bitPosition + 4 <= totalBits) {
    const mode = read(4);
    if (mode === 0) break; // terminator

    if (mode === 4) {
      const count = read(countBits('byte'));
      const chunk = new Uint8Array(count);
      for (let i = 0; i < count; i++) chunk[i] = read(8);
      out.push(new TextDecoder().decode(chunk));
    } else if (mode === 2) {
      const count = read(countBits('alphanumeric'));
      let produced = 0;
      while (produced + 2 <= count) {
        const pair = read(11);
        out.push(ALPHANUMERIC[Math.floor(pair / 45)] + ALPHANUMERIC[pair % 45]);
        produced += 2;
      }
      if (produced < count) out.push(ALPHANUMERIC[read(6)]);
    } else if (mode === 1) {
      const count = read(countBits('numeric'));
      let produced = 0;
      while (produced + 3 <= count) {
        out.push(String(read(10)).padStart(3, '0'));
        produced += 3;
      }
      if (count - produced === 2) out.push(String(read(7)).padStart(2, '0'));
      else if (count - produced === 1) out.push(String(read(4)));
    } else if (mode === 7) {
      // ECI: skip the assignment number and carry on as UTF-8.
      const first = read(8);
      if (first & 0x80) read(first & 0xc0 ? 16 : 8);
    } else {
      throw new Error('unsupported encoding mode in this QR code');
    }
  }
  return out.join('');
}

// ------------------------------------------------------- image to modules

const BLOCK = 8;

// Local thresholding, because a QR on a web page sits on whatever background the
// page felt like using and a single global cutoff loses the edges.
function binarize(imageData) {
  const { width, height, data } = imageData;
  const luminance = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    // Rough luma; the exact coefficients do not matter for black-on-white.
    luminance[i] = (data[offset] * 77 + data[offset + 1] * 150 + data[offset + 2] * 29) >> 8;
  }

  const blocksX = Math.max(1, Math.ceil(width / BLOCK));
  const blocksY = Math.max(1, Math.ceil(height / BLOCK));
  const thresholds = new Uint8Array(blocksX * blocksY);

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let min = 255;
      let max = 0;
      let sum = 0;
      let count = 0;
      for (let y = by * BLOCK; y < Math.min(height, (by + 1) * BLOCK); y++) {
        for (let x = bx * BLOCK; x < Math.min(width, (bx + 1) * BLOCK); x++) {
          const value = luminance[y * width + x];
          if (value < min) min = value;
          if (value > max) max = value;
          sum += value;
          count += 1;
        }
      }
      // A flat block is all background: bias below it so nothing is called dark.
      thresholds[by * blocksX + bx] = max - min > 24 ? sum / count : Math.max(0, min - 1);
    }
  }

  // Average each block's threshold with its neighbours so block seams do not show
  // up as fake edges.
  const smoothed = new Uint8Array(blocksX * blocksY);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let sum = 0;
      let count = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= blocksX || ny >= blocksY) continue;
          sum += thresholds[ny * blocksX + nx];
          count += 1;
        }
      }
      smoothed[by * blocksX + bx] = sum / count;
    }
  }

  const bits = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const by = Math.min(blocksY - 1, y >> 3);
    for (let x = 0; x < width; x++) {
      const bx = Math.min(blocksX - 1, x >> 3);
      bits[y * width + x] = luminance[y * width + x] < smoothed[by * blocksX + bx] ? 1 : 0;
    }
  }
  return { bits, width, height };
}

// A finder pattern is dark-light-dark-light-dark in 1:1:3:1:1 proportion.
function ratioLooksRight(runs) {
  const total = runs[0] + runs[1] + runs[2] + runs[3] + runs[4];
  if (total < 7) return false;
  const unit = total / 7;
  const slack = unit / 1.6;
  return (
    Math.abs(unit - runs[0]) < slack &&
    Math.abs(unit - runs[1]) < slack &&
    Math.abs(unit * 3 - runs[2]) < slack * 3 &&
    Math.abs(unit - runs[3]) < slack &&
    Math.abs(unit - runs[4]) < slack
  );
}

// Having found the ratio across a row, walk the same column (or row) to confirm
// it and to pin down the centre on that axis. A structure that happens to match
// the ratio in one direction rarely matches in both.
function crossCheck(binary, startX, startY, vertical) {
  const { bits, width, height } = binary;
  const limit = vertical ? height : width;
  const dark = (position) => {
    const x = vertical ? startX : position;
    const y = vertical ? position : startY;
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    return bits[y * width + x] === 1;
  };

  const start = vertical ? startY : startX;
  if (!dark(start)) return null;

  const runs = [0, 0, 0, 0, 0];
  let position = start;
  while (dark(position)) {
    runs[2] += 1;
    position -= 1;
  }
  while (position >= 0 && !dark(position)) {
    runs[1] += 1;
    position -= 1;
  }
  while (dark(position)) {
    runs[0] += 1;
    position -= 1;
  }

  position = start + 1;
  while (dark(position)) {
    runs[2] += 1;
    position += 1;
  }
  const middleEnd = position;
  while (position < limit && !dark(position)) {
    runs[3] += 1;
    position += 1;
  }
  while (dark(position)) {
    runs[4] += 1;
    position += 1;
  }

  if (!ratioLooksRight(runs)) return null;
  return {
    centre: middleEnd - runs[2] / 2,
    size: runs.reduce((sum, run) => sum + run, 0) / 7,
  };
}

function findFinders(binary) {
  const { bits, width, height } = binary;
  const candidates = [];

  // Even run slots count dark, odd count light. Starting mid-pattern is fine:
  // the first ratio check fails, the counts shift back two, and it locks on.
  for (let y = 0; y < height; y += 2) {
    const runs = [0, 0, 0, 0, 0];
    let state = 0;

    const consider = (endX) => {
      if (!ratioLooksRight(runs)) return false;
      const rowSize = runs.reduce((sum, run) => sum + run, 0) / 7;
      const centreX = endX - runs[4] - runs[3] - runs[2] / 2;

      const down = crossCheck(binary, Math.round(centreX), y, true);
      if (!down) return true;
      // Re-measure across the confirmed centre row, not the row we happened to
      // scan, and only keep the candidate if both axes agree on the size.
      const across = crossCheck(binary, Math.round(centreX), Math.round(down.centre), false);
      if (!across) return true;
      if (Math.abs(across.size - down.size) > Math.max(across.size, down.size) / 2) return true;

      candidates.push({
        x: across.centre,
        y: down.centre,
        size: (rowSize + down.size + across.size) / 3,
      });
      return true;
    };

    for (let x = 0; x < width; x++) {
      if (bits[y * width + x] === 1) {
        if (state & 1) state += 1;
        runs[state] += 1;
      } else if ((state & 1) === 0) {
        if (state === 4) {
          if (consider(x)) {
            runs.fill(0);
            state = 0;
          } else {
            runs[0] = runs[2];
            runs[1] = runs[3];
            runs[2] = runs[4];
            runs[3] = 1;
            runs[4] = 0;
            state = 3;
          }
        } else {
          state += 1;
          runs[state] += 1;
        }
      } else {
        runs[state] += 1;
      }
    }
    // A pattern touching the right edge finishes the row still in state 4.
    if (state === 4) consider(width);
  }

  // Merge candidates that are really the same pattern seen on several rows.
  const clusters = [];
  for (const candidate of candidates) {
    const match = clusters.find(
      (cluster) =>
        Math.abs(cluster.x - candidate.x) < candidate.size * 2 &&
        Math.abs(cluster.y - candidate.y) < candidate.size * 2,
    );
    if (match) {
      match.x = (match.x * match.count + candidate.x) / (match.count + 1);
      match.y = (match.y * match.count + candidate.y) / (match.count + 1);
      match.size = (match.size * match.count + candidate.size) / (match.count + 1);
      match.count += 1;
    } else {
      clusters.push({ ...candidate, count: 1 });
    }
  }

  const solid = clusters.filter((cluster) => cluster.count >= 2);
  if (solid.length < 3) return null;
  if (solid.length === 3) return solid;

  // More than three candidates means something else on the page matched the
  // ratio. Pick the triple that actually looks like the corners of a QR code:
  // three patterns of the same size forming a right-angled isosceles triangle.
  // Choosing by how many rows each was seen on picks up big false positives.
  let best = null;
  const limit = Math.min(solid.length, 12);
  for (let a = 0; a < limit; a++) {
    for (let b = a + 1; b < limit; b++) {
      for (let c = b + 1; c < limit; c++) {
        const trio = [solid[a], solid[b], solid[c]];
        const sizes = trio.map((pattern) => pattern.size);
        const meanSize = (sizes[0] + sizes[1] + sizes[2]) / 3;
        if (meanSize <= 0) continue;
        const sizeSpread =
          Math.max(...sizes.map((size) => Math.abs(size - meanSize))) / meanSize;
        if (sizeSpread > 0.4) continue;

        const distance = (one, two) => Math.hypot(one.x - two.x, one.y - two.y);
        const legs = [
          distance(trio[0], trio[1]),
          distance(trio[0], trio[2]),
          distance(trio[1], trio[2]),
        ].sort((one, two) => one - two);
        if (legs[0] < meanSize * 7) continue;

        // The two short sides should match, and the long one should be their
        // diagonal.
        const legSpread = Math.abs(legs[0] - legs[1]) / legs[1];
        const diagonalError = Math.abs(legs[2] - Math.SQRT2 * ((legs[0] + legs[1]) / 2)) / legs[2];
        const score = sizeSpread + legSpread + diagonalError;
        if (!best || score < best.score) best = { score, trio };
      }
    }
  }
  return best ? best.trio : null;
}

// Work out which corner each pattern sits in.
function orderFinders(found) {
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const [a, b, c] = found;
  const sides = [
    { length: distance(b, c), opposite: a, ends: [b, c] },
    { length: distance(a, c), opposite: b, ends: [a, c] },
    { length: distance(a, b), opposite: c, ends: [a, b] },
  ].sort((one, two) => two.length - one.length);

  // The corner opposite the longest side is the top-left one.
  const topLeft = sides[0].opposite;
  let [first, second] = sides[0].ends;

  // Cross product decides which of the other two is the top-right.
  const cross =
    (first.x - topLeft.x) * (second.y - topLeft.y) - (first.y - topLeft.y) * (second.x - topLeft.x);
  if (cross < 0) [first, second] = [second, first];
  return { topLeft, topRight: first, bottomLeft: second };
}

function sampleGrid(binary, order, dimension) {
  const { bits, width, height } = binary;
  const { topLeft, topRight, bottomLeft } = order;
  const span = dimension - 7;

  // Affine map from module coordinates to pixels. The finder centres sit at
  // module 3.5, which anchors it. Perspective is not modelled: a screenshot of a
  // screen is flat.
  const stepX = { x: (topRight.x - topLeft.x) / span, y: (topRight.y - topLeft.y) / span };
  const stepY = { x: (bottomLeft.x - topLeft.x) / span, y: (bottomLeft.y - topLeft.y) / span };

  const matrix = new Uint8Array(dimension * dimension);
  // A single centre pixel is enough when the modules are large, but at three or
  // four pixels per module a half-pixel error in the estimate lands on an edge.
  // Voting over the centre and its four neighbours absorbs that.
  const votes = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];

  for (let row = 0; row < dimension; row++) {
    for (let column = 0; column < dimension; column++) {
      const mx = column + 0.5 - 3.5;
      const my = row + 0.5 - 3.5;
      const cx = topLeft.x + mx * stepX.x + my * stepY.x;
      const cy = topLeft.y + mx * stepX.y + my * stepY.y;

      let dark = 0;
      let counted = 0;
      for (const [dx, dy] of votes) {
        const px = Math.round(cx) + dx;
        const py = Math.round(cy) + dy;
        if (px < 0 || py < 0 || px >= width || py >= height) continue;
        dark += bits[py * width + px];
        counted += 1;
      }
      if (counted === 0) return null;
      matrix[row * dimension + column] = dark * 2 > counted ? 1 : 0;
    }
  }
  return matrix;
}

// Find and decode a QR code anywhere in an image.
export function decodeImageData(imageData) {
  const binary = binarize(imageData);
  const found = findFinders(binary);
  if (!found) throw new Error('No QR code found in that image.');

  const order = orderFinders(found);
  // Median, not mean: one finder measured at twice the true size would otherwise
  // drag the estimate far enough to pick the wrong symbol size.
  const sizes = [order.topLeft.size, order.topRight.size, order.bottomLeft.size].sort(
    (a, b) => a - b,
  );
  const moduleSize = sizes[1];
  if (!(moduleSize > 0)) throw new Error('No QR code found in that image.');

  const across = Math.hypot(
    order.topRight.x - order.topLeft.x,
    order.topRight.y - order.topLeft.y,
  );
  let estimate = Math.round(across / moduleSize) + 7;
  // Valid dimensions are 4v+17, so snap to the nearest one.
  estimate -= (estimate - 17) % 4;

  // The estimate can land one step out when the modules are only a few pixels
  // across. Trying the neighbours costs nothing and the format check rejects a
  // wrong guess immediately.
  const failures = [];
  for (const dimension of [estimate, estimate + 4, estimate - 4]) {
    const version = versionFor(dimension);
    if (version < 1 || version > MAX_VERSION) continue;
    const matrix = sampleGrid(binary, order, dimension);
    if (!matrix) continue;
    try {
      return decodeMatrix(matrix, dimension);
    } catch (error) {
      failures.push(error.message);
    }
  }

  const version = versionFor(estimate);
  if (version > MAX_VERSION) {
    throw new Error(
      `That QR code is version ${version}; the scanner handles 1 to ${MAX_VERSION}. Paste the otpauth:// link instead.`,
    );
  }
  throw new Error(failures[0] || 'That QR code could not be read.');
}

// Decode a module matrix that has already been sampled. Exported so the pipeline
// can be tested against a known-good grid without going through an image.
export function decodeMatrix(matrix, dimension) {
  const version = versionFor(dimension);
  if (version < 1 || version > MAX_VERSION) {
    throw new Error(
      `This QR code is version ${version || '?'}; the scanner handles 1 to ${MAX_VERSION}.`,
    );
  }
  const { ecLevel, mask } = readFormat(matrix, dimension);
  const raw = readCodewords(matrix, version, mask);
  const data = correctCodewords(raw, version, ecLevel);
  return decodeBitstream(data, version);
}


