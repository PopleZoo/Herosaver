/**
 * Minimal ZIP writer (STORE method, no compression).
 * PNG data is already compressed so STORE keeps files small enough and avoids
 * pulling a compression library into the userscript bundle.
 */

// CRC-32 lookup table (IEEE 802.3)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32 (data) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime (date) {
  const d = date || new Date()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const day = (d.getFullYear() - 1980) << 9 | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time: time & 0xFFFF, date: day & 0xFFFF }
}

function concatBytes (arrays) {
  let total = 0
  for (const a of arrays) total += a.byteLength
  const out = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    out.set(a, offset)
    offset += a.byteLength
  }
  return out
}

/**
 * Build a ZIP archive from named file entries.
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @returns {Uint8Array} ZIP archive bytes
 */
export function createZip (entries) {
  const encoder = new TextEncoder()
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name)
    const data = entry.data instanceof Uint8Array ? entry.data : encoder.encode(String(entry.data))
    const crc = crc32(data)
    const { time, date } = dosDateTime()

    // Local file header
    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // signature
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: STORE
    lv.setUint16(10, time, true)
    lv.setUint16(12, date, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true) // compressed size
    lv.setUint32(22, data.length, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true) // extra length
    local.set(nameBytes, 30)
    localParts.push(local, data)

    // Central directory header
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true) // signature
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0, true) // flags
    cv.setUint16(10, 0, true) // method
    cv.setUint16(12, time, true)
    cv.setUint16(14, date, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true) // extra
    cv.setUint16(32, 0, true) // comment
    cv.setUint16(34, 0, true) // disk number
    cv.setUint16(36, 0, true) // internal attrs
    cv.setUint32(38, 0, true) // external attrs
    cv.setUint32(42, offset, true) // local header offset
    central.set(nameBytes, 46)
    centralParts.push(central)

    offset += 30 + nameBytes.length + data.length
  }

  // End of central directory
  const cdSize = centralParts.reduce((n, p) => n + p.byteLength, 0)
  const eocd = new Uint8Array(22)
  const ev = new DataView(eocd.buffer)
  ev.setUint32(0, 0x06054b50, true) // signature
  ev.setUint16(4, 0, true) // disk number
  ev.setUint16(6, 0, true) // disk with cd
  ev.setUint16(8, entries.length, true) // entries on disk
  ev.setUint16(10, entries.length, true) // total entries
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true) // cd offset
  ev.setUint16(20, 0, true) // comment length

  return concatBytes([...localParts, ...centralParts, eocd])
}
