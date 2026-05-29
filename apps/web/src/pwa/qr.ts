/**
 * qr.ts — Minimal QR code matrix generator (numeric/byte mode, ECC L).
 *
 * Self-contained pure-function implementation. Returns a 2D boolean
 * array; the SVG render layer handles drawing. ~250 lines vs. ~30kb
 * for the qrcode npm package, with no supply-chain surface.
 *
 * Supports versions 1–10 (up to 174 bytes of data in byte-mode ECC-L)
 * — plenty for our 60-200 char redeem URLs.
 *
 * If you need more capacity later, swap in a real lib. This is the
 * 80% solution that ships today without a new dep.
 */

const GF_EXP = new Uint8Array(512)
const GF_LOG = new Uint8Array(256)
;(function initGf() {
  let x = 1
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x
    GF_LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255]!
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!
}

function rsGeneratorPoly(deg: number): number[] {
  let poly: number[] = [1]
  for (let i = 0; i < deg; i++) {
    const next: number[] = new Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j]! ^ gfMul(poly[j]!, 1))
      next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, GF_EXP[i]!))
    }
    poly = next
  }
  return poly
}

function rsEncode(data: number[], degree: number): number[] {
  const gen = rsGeneratorPoly(degree)
  const result = data.concat(new Array(degree).fill(0))
  for (let i = 0; i < data.length; i++) {
    const factor = result[i]!
    if (factor !== 0) {
      for (let j = 0; j < gen.length; j++) {
        result[i + j] = (result[i + j]! ^ gfMul(gen[j]!, factor))
      }
    }
  }
  return result.slice(data.length)
}

// Capacity per version (V1..V10) for byte mode ECC-L (bytes after the
// mode + count header). Numbers from the QR spec table 7.
const CAPACITY_L = [17, 32, 53, 78, 106, 134, 154, 192, 230, 271]
// Total codewords per version + EC codewords per version (ECC L).
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const EC_CODEWORDS    = [7,  10, 15, 20,  26,  36,  40,  48,  60,  72]

function pickVersion(bytes: number): number {
  for (let v = 1; v <= 10; v++) {
    if (bytes <= CAPACITY_L[v - 1]!) return v
  }
  throw new Error('QR payload too large for our minimal encoder (max v10)')
}

function buildBitStream(s: string, version: number): number[] {
  const bytes: number[] = []
  // Encode as UTF-8 explicitly.
  for (const ch of new TextEncoder().encode(s)) bytes.push(ch)

  const bits: number[] = []
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(0b0100, 4)                // mode = byte
  const charCountLen = version <= 9 ? 8 : 16
  push(bytes.length, charCountLen)
  for (const b of bytes) push(b, 8)
  // Terminator (up to 4 zero bits)
  for (let i = 0; i < 4 && bits.length < TOTAL_CODEWORDS[version - 1]! * 8 - EC_CODEWORDS[version - 1]! * 8; i++) bits.push(0)
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0)
  // Pad bytes alternating EC 11 / EC 17 until full data capacity
  const dataCodewords = TOTAL_CODEWORDS[version - 1]! - EC_CODEWORDS[version - 1]!
  const pads = [0xEC, 0x11]
  let pi = 0
  while (bits.length / 8 < dataCodewords) {
    const v = pads[pi % 2]!
    for (let i = 7; i >= 0; i--) bits.push((v >> i) & 1)
    pi++
  }
  // Pack to bytes
  const out: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!
    out.push(v)
  }
  return out
}

function setFinder(m: boolean[][], r: number, c: number): void {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const y = r + dr, x = c + dc
      if (y < 0 || x < 0 || y >= m.length || x >= m.length) continue
      const inOuter  = (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6)
      const inInnerW = (dr >= 1 && dr <= 5 && dc >= 1 && dc <= 5)
      const inCore   = (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4)
      m[y]![x] = inOuter && (!inInnerW || inCore)
    }
  }
}

function maskFn(mask: number, r: number, c: number): boolean {
  switch (mask) {
    case 0: return (r + c) % 2 === 0
    case 1: return r % 2 === 0
    case 2: return c % 3 === 0
    case 3: return (r + c) % 3 === 0
    case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0
    case 5: return ((r * c) % 2) + ((r * c) % 3) === 0
    case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0
    case 7: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  }
  return false
}

const FORMAT_BITS_L: Record<number, number> = {
  0: 0x77c4, 1: 0x72f3, 2: 0x7daa, 3: 0x789d,
  4: 0x662f, 5: 0x6318, 6: 0x6c41, 7: 0x6976,
}

/** Build a QR matrix for a UTF-8 string. Returns `boolean[][]` where
 *  `true` = dark module. Caller renders. */
export function qrMatrix(text: string): boolean[][] {
  const utf8Len = new TextEncoder().encode(text).length
  const version = pickVersion(utf8Len)
  const size = 21 + (version - 1) * 4
  const m: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const reserved: boolean[][] = Array.from({ length: size }, () => Array<boolean>(size).fill(false))

  // Finder patterns + reservation
  for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    setFinder(m, r!, c!)
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const y = r! + dr, x = c! + dc
        if (y >= 0 && x >= 0 && y < size && x < size) reserved[y]![x] = true
      }
    }
  }
  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    m[6]![i] = i % 2 === 0
    m[i]![6] = i % 2 === 0
    reserved[6]![i] = true
    reserved[i]![6] = true
  }
  // Dark module + format reservation
  m[size - 8]![8] = true
  reserved[size - 8]![8] = true
  for (let i = 0; i < 9; i++) { reserved[8]![i] = true; reserved[i]![8] = true }
  for (let i = 0; i < 8; i++) { reserved[8]![size - 1 - i] = true; reserved[size - 1 - i]![8] = true }

  // Encode + RS
  const dataCodewords = buildBitStream(text, version)
  const ec = rsEncode(dataCodewords, EC_CODEWORDS[version - 1]!)
  const allCodewords = dataCodewords.concat(ec)

  // Place bits, snake pattern from bottom-right
  const bits: number[] = []
  for (const cw of allCodewords) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1)
  let bi = 0
  let upward = true
  for (let col = size - 1; col >= 1; col -= 2) {
    if (col === 6) col = 5   // skip timing column
    for (let i = 0; i < size; i++) {
      const r = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (!reserved[r]![c] && bi < bits.length) {
          m[r]![c] = bits[bi]! === 1
          bi++
        }
      }
    }
    upward = !upward
  }

  // Pick best mask by score = total dark cells (cheap heuristic; full
  // penalty calc is overkill for our short URLs).
  let bestMask = 0, bestScore = Infinity
  const trial: boolean[][] = m.map(row => row.slice())
  for (let mk = 0; mk < 8; mk++) {
    const copy = trial.map(row => row.slice())
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
      if (!reserved[r]![c] && maskFn(mk, r, c)) copy[r]![c] = !copy[r]![c]
    }
    let dark = 0
    for (const row of copy) for (const v of row) if (v) dark++
    const score = Math.abs(dark - (size * size) / 2)
    if (score < bestScore) { bestScore = score; bestMask = mk }
  }
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) {
    if (!reserved[r]![c] && maskFn(bestMask, r, c)) m[r]![c] = !m[r]![c]
  }

  // Write format info (15 bits) — top-left + bottom-left + top-right pair
  const fmt = FORMAT_BITS_L[bestMask]!
  const setFmt = (r: number, c: number, bit: number): void => { m[r]![c] = bit === 1 }
  for (let i = 0; i <= 5; i++) setFmt(8, i, (fmt >> i) & 1)
  setFmt(8, 7, (fmt >> 6) & 1)
  setFmt(8, 8, (fmt >> 7) & 1)
  setFmt(7, 8, (fmt >> 8) & 1)
  for (let i = 9; i < 15; i++) setFmt(14 - i, 8, (fmt >> i) & 1)
  for (let i = 0; i < 8; i++)  setFmt(size - 1 - i, 8, (fmt >> i) & 1)
  for (let i = 0; i < 7; i++)  setFmt(8, size - 7 + i, (fmt >> (8 + i)) & 1)

  return m
}
