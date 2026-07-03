/*
 * zip.js
 * ------
 * Minimal, dependency-free ZIP writer (STORE method — no compression).
 *
 * Enough to bundle a Markdown file plus attachment binaries into a single
 * {issueKey}.zip so a Jira issue can be saved as one self-contained folder.
 * STORE keeps the code tiny; issue attachments are usually already-compressed
 * images/PDFs where DEFLATE would buy little anyway.
 *
 * Used by the popup (loaded via <script>): window.MiniZip.build(files) -> Blob
 *   files: [{ name: string, data: Uint8Array | string }]
 */
(function (root) {
  'use strict';

  // Precomputed CRC-32 table.
  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  const encoder = new TextEncoder();

  function toBytes(data) {
    if (typeof data === 'string') return encoder.encode(data);
    if (data instanceof Uint8Array) return data;
    return new Uint8Array(data);
  }

  function writeUint32(view, offset, value) {
    view.setUint32(offset, value >>> 0, true);
  }
  function writeUint16(view, offset, value) {
    view.setUint16(offset, value & 0xffff, true);
  }

  function build(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes = toBytes(file.data);
      const crc = crc32(dataBytes);

      // Local file header (30 bytes + name + data)
      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      writeUint32(lv, 0, 0x04034b50); // signature
      writeUint16(lv, 4, 20); // version needed
      writeUint16(lv, 6, 0); // flags
      writeUint16(lv, 8, 0); // method = store
      writeUint16(lv, 10, 0); // mod time
      writeUint16(lv, 12, 0); // mod date
      writeUint32(lv, 14, crc);
      writeUint32(lv, 18, dataBytes.length); // compressed size
      writeUint32(lv, 22, dataBytes.length); // uncompressed size
      writeUint16(lv, 26, nameBytes.length);
      writeUint16(lv, 28, 0); // extra length
      localHeader.set(nameBytes, 30);

      localParts.push(localHeader, dataBytes);

      // Central directory header (46 bytes + name)
      const central = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(central.buffer);
      writeUint32(cv, 0, 0x02014b50); // signature
      writeUint16(cv, 4, 20); // version made by
      writeUint16(cv, 6, 20); // version needed
      writeUint16(cv, 8, 0); // flags
      writeUint16(cv, 10, 0); // method
      writeUint16(cv, 12, 0); // mod time
      writeUint16(cv, 14, 0); // mod date
      writeUint32(cv, 16, crc);
      writeUint32(cv, 20, dataBytes.length);
      writeUint32(cv, 24, dataBytes.length);
      writeUint16(cv, 28, nameBytes.length);
      writeUint16(cv, 30, 0); // extra
      writeUint16(cv, 32, 0); // comment
      writeUint16(cv, 34, 0); // disk number
      writeUint16(cv, 36, 0); // internal attrs
      writeUint32(cv, 38, 0); // external attrs
      writeUint32(cv, 42, offset); // local header offset
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += localHeader.length + dataBytes.length;
    }

    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const centralOffset = offset;

    // End of central directory record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    writeUint32(ev, 0, 0x06054b50);
    writeUint16(ev, 4, 0); // disk number
    writeUint16(ev, 6, 0); // disk with central dir
    writeUint16(ev, 8, files.length);
    writeUint16(ev, 10, files.length);
    writeUint32(ev, 12, centralSize);
    writeUint32(ev, 16, centralOffset);
    writeUint16(ev, 20, 0); // comment length

    return new Blob([...localParts, ...centralParts, eocd], { type: 'application/zip' });
  }

  function base64ToBytes(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  root.MiniZip = { build, crc32, base64ToBytes };
})(typeof self !== 'undefined' ? self : this);
