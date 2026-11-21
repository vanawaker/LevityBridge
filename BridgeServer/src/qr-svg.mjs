/**
 * Zero-dependency QR Code SVG generator (Byte mode, ECC Level L, Versions 1..10).
 * Supports pairing URLs up to 271 UTF-8 bytes without external npm packages.
 */

// Capacities (data codewords) and EC codewords per block for ECC Level L, Versions 1..10
const VERSION_TABLE = [
  null,
  { total: 26, data: 19, ecPerBlock: 7, blocks: [1, 19, 0, 0], align: [] },
  { total: 44, data: 34, ecPerBlock: 10, blocks: [1, 34, 0, 0], align: [6, 18] },
  { total: 70, data: 55, ecPerBlock: 15, blocks: [1, 55, 0, 0], align: [6, 22] },
  { total: 100, data: 80, ecPerBlock: 20, blocks: [1, 80, 0, 0], align: [6, 26] },
  { total: 134, data: 108, ecPerBlock: 26, blocks: [1, 108, 0, 0], align: [6, 30] },
  { total: 172, data: 136, ecPerBlock: 18, blocks: [2, 68, 0, 0], align: [6, 34] },
  { total: 196, data: 156, ecPerBlock: 20, blocks: [2, 78, 0, 0], align: [6, 22, 38] },
  { total: 242, data: 194, ecPerBlock: 24, blocks: [2, 97, 0, 0], align: [6, 24, 42] },
  { total: 292, data: 232, ecPerBlock: 30, blocks: [2, 116, 0, 0], align: [6, 26, 46] },
  { total: 346, data: 274, ecPerBlock: 18, blocks: [2, 68, 2, 69], align: [6, 28, 50] },
];

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(dataBytes, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (const b of dataBytes) {
    const factor = b ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    for (let j = 0; j < ecLen; j++) {
      rem[j] ^= gfMul(gen[j + 1], factor);
    }
  }
  return rem;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= 10; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const neededBits = 4 + countBits + byteLen * 8;
    if (Math.ceil(neededBits / 8) <= VERSION_TABLE[v].data) return v;
  }
  throw new Error(`QR payload too long (${byteLen} bytes)`);
}

function encodeDataCodewords(utf8Bytes, version) {
  const spec = VERSION_TABLE[version];
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
  };
  pushBits(0b0100, 4); // Byte mode
  pushBits(utf8Bytes.length, version <= 9 ? 8 : 16);
  for (const b of utf8Bytes) pushBits(b, 8);

  const capacityBits = spec.data * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  pushBits(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (codewords.length < spec.data) {
    codewords.push(padBytes[padIdx % 2]);
    padIdx++;
  }
  return Uint8Array.from(codewords);
}

function interleaveCodewords(dataCodewords, version) {
  const spec = VERSION_TABLE[version];
  const [g1Blocks, g1Len, g2Blocks, g2Len] = spec.blocks;
  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let i = 0; i < g1Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g1Len);
    offset += g1Len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }
  for (let i = 0; i < g2Blocks; i++) {
    const block = dataCodewords.slice(offset, offset + g2Len);
    offset += g2Len;
    dataBlocks.push(block);
    ecBlocks.push(rsEncode(block, spec.ecPerBlock));
  }

  const out = [];
  const maxDataLen = Math.max(g1Len, g2Len);
  for (let i = 0; i < maxDataLen; i++) {
    for (const b of dataBlocks) if (i < b.length) out.push(b[i]);
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (const b of ecBlocks) out.push(b[i]);
  }
  return out;
}

function createMatrix(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunc = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  const placeFinder = (top, left) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inOuter = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const inRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCenter = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        setFunc(top + r, left + c, inOuter && (inRing || inCenter));
      }
    }
  };

  placeFinder(0, 0);
  placeFinder(0, size - 7);
  placeFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i++) {
    setFunc(6, i, i % 2 === 0);
    setFunc(i, 6, i % 2 === 0);
  }

  const align = VERSION_TABLE[version].align;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) {
        continue;
      }
      const cr = align[i];
      const cc = align[j];
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const dark = Math.max(Math.abs(r), Math.abs(c)) !== 1;
          setFunc(cr + r, cc + c, dark);
        }
      }
    }
  }

  // Reserve format info bits & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunc(8, i, false);
      setFunc(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunc(8, size - 1 - i, false);
    setFunc(size - 1 - i, 8, false);
  }
  setFunc(size - 8, 8, true);

  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunc(a, b, bit);
      setFunc(b, a, bit);
    }
  }

  return { size, modules, isFunc };
}

function drawFormatBits(modules, size, mask) {
  // ECC Level L = 01
  const data = (0b01 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) modules[8][i] = bit(i) ? 1 : 0;
  modules[8][7] = bit(6) ? 1 : 0;
  modules[8][8] = bit(7) ? 1 : 0;
  modules[7][8] = bit(8) ? 1 : 0;
  for (let i = 9; i < 15; i++) modules[14 - i][8] = bit(i) ? 1 : 0;

  for (let i = 0; i < 8; i++) modules[size - 1 - i][8] = bit(i) ? 1 : 0;
  for (let i = 8; i < 15; i++) modules[8][size - 15 + i] = bit(i) ? 1 : 0;
  modules[size - 8][8] = 1;
}

export function generateQrSvg(text, { margin = 2, fg = '#F8FAFC', bg = '#0B0F19' } = {}) {
  const utf8 = Buffer.from(String(text), 'utf-8');
  const version = pickVersion(utf8.length);
  const codewords = interleaveCodewords(encodeDataCodewords(utf8, version), version);
  const { size, modules, isFunc } = createMatrix(version);

  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        const upward = ((right + 1) & 2) === 0;
        const r = upward ? size - 1 - vert : vert;
        if (!isFunc[r][c] && bitIdx < totalBits) {
          const dark = ((codewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
          modules[r][c] = dark ? 1 : 0;
          bitIdx++;
        }
      }
    }
  }

  // Mask 0: (r + c) % 2 === 0
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!isFunc[r][c] && (r + c) % 2 === 0) {
        modules[r][c] ^= 1;
      }
    }
  }
  drawFormatBits(modules, size, 0);

  const viewSize = size + margin * 2;
  const rects = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        rects.push(`M${c + margin},${r + margin}h1v1h-1z`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewSize} ${viewSize}" shape-rendering="crispEdges"><rect width="${viewSize}" height="${viewSize}" rx="2" fill="${bg}"/><path d="${rects.join('')}" fill="${fg}"/></svg>`;
}
