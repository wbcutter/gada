/**
 * UniversalZip - High-performance, zero-dependency ZIP/CBZ/EPUB packager for Userscripts & Web.
 * 
 * Features:
 * - 100% CSP-Safe: Does NOT spawn external/blob Web Workers (bypasses strict Manga/Comic site CSPs).
 * - EPUB 3.x / 2.0 Compliant: Enforces uncompressed "mimetype" at index 0 and removes extra fields.
 * - CBZ Optimized: Automatically skips Deflate compression for pre-compressed images (.jpg, .png, .webp, etc.),
 *   preventing CPU overload and Out-of-Memory (OOM) browser tab crashes.
 * - Standard PKWARE Compliance: Forces General Purpose Bit 11 (0x0800) for full UTF-8 filename support
 *   (prevents corrupt filenames with non-ASCII / Unicode / accented characters).
 * - Native Deflate Compression: Leverages browser-native `CompressionStream('deflate-raw')`.
 * - Cross-environment support: Integrates seamlessly with Tampermonkey's `GM_download` and standard DOM downloads.
 * 
 * @license MIT
 * @version 1.0.0
 */
class UniversalZip {
  constructor() {
    this.entries = [];
  }

  // Precomputed CRC-32 table for high-speed checksumming
  static crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  })();

  /**
   * Calculates the 32-bit Cyclic Redundancy Check (CRC-32) of a byte array.
   * @param {Uint8Array} buf - Target buffer
   * @returns {number} Unsigned 32-bit CRC checksum
   */
  static crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ UniversalZip.crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
  }

  /**
   * Converts a JavaScript Date object into MS-DOS 16-bit date and time formats.
   * @param {Date} [d=new Date()] 
   * @returns {{dosTime: number, dosDate: number}}
   */
  static toDosTime(d = new Date()) {
    const year = Math.max(1980, d.getFullYear());
    const dosDate = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    return { dosTime, dosDate };
  }

  /**
   * Compresses byte array using the browser's native Deflate-raw stream.
   * @param {Uint8Array} bytes 
   * @returns {Promise<Uint8Array>}
   */
  static async deflateRaw(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        const res = new Response(cs.readable);
        return new Uint8Array(await res.arrayBuffer());
      } catch (err) {
        // Fallback to uncompressed if browser stream fails
        return bytes;
      }
    }
    return bytes;
  }

  /**
   * Adds a file or document to the archive.
   * 
   * @param {string} path - Relative file path inside the archive (e.g. "mimetype", "OEBPS/chapter1.xhtml", "001.jpg")
   * @param {string|Uint8Array|ArrayBuffer|Blob|File} content - File data
   * @param {Object} [options={}] - Custom options
   * @param {boolean} [options.compress] - Explicitly enable/disable Deflate compression
   * @param {Date} [options.date] - Last modified timestamp
   */
  async addFile(path, content, options = {}) {
    // Normalize path to standard Unix forward slashes
    path = path.replace(/\\/g, '/');

    // 1. Normalize input content into a Uint8Array
    let rawBytes;
    if (typeof content === 'string') {
      rawBytes = new TextEncoder().encode(content);
    } else if (content instanceof Uint8Array) {
      rawBytes = content;
    } else if (content instanceof ArrayBuffer) {
      rawBytes = new Uint8Array(content);
    } else if (content instanceof Blob || (typeof File !== 'undefined' && content instanceof File)) {
      rawBytes = new Uint8Array(await content.arrayBuffer());
    } else if (!content) {
      rawBytes = new Uint8Array(0);
    } else {
      throw new Error(`[UniversalZip] Unsupported content type for file: "${path}"`);
    }

    // 2. Intelligent Compression Detection:
    // - EPUB 'mimetype': MUST BE STORED (Method 0 - No compression) per IDPF spec.
    // - Pre-compressed media (.jpg, .png, .webp, .avif, .gif): Skip Deflate to save CPU & prevent browser crashes.
    // - Text files (.html, .css, .xml, .txt, .json): Deflate enabled.
    const isImage = /\.(jpe?g|png|webp|avif|gif)$/i.test(path);
    const isEpubMime = path === 'mimetype';
    
    let shouldCompress = false;
    if (options.compress !== undefined) {
      shouldCompress = options.compress;
    } else {
      shouldCompress = !isImage && !isEpubMime;
    }

    let finalBytes = rawBytes;
    let method = 0; // 0: Store (Uncompressed)

    if (shouldCompress && rawBytes.length > 0) {
      const deflated = await UniversalZip.deflateRaw(rawBytes);
      if (deflated.length < rawBytes.length) {
        finalBytes = deflated;
        method = 8; // 8: Deflate
      }
    }

    const nameBytes = new TextEncoder().encode(path);
    const { dosTime, dosDate } = UniversalZip.toDosTime(options.date || new Date());

    this.entries.push({
      path,
      nameBytes,
      data: finalBytes,
      uncompressedSize: rawBytes.length,
      compressedSize: finalBytes.length,
      crc: UniversalZip.crc32(rawBytes),
      method,
      dosTime,
      dosDate,
      isDir: path.endsWith('/')
    });
  }

  /**
   * Adds an empty directory entry.
   * @param {string} path - Folder path (e.g. "images/" or "META-INF")
   */
  async addFolder(path) {
    if (!path.endsWith('/')) path += '/';
    await this.addFile(path, new Uint8Array(0), { compress: false });
  }

  /**
   * Generates the binary ZIP archive as a Blob.
   * @param {string} [mimeType='application/zip'] - Output MIME type
   * @returns {Blob}
   */
  generateBlob(mimeType = 'application/zip') {
    const parts = [];
    const centralHeaders = [];
    let offset = 0;

    // Process Local File Headers & File Data
    for (const entry of this.entries) {
      // 1. LOCAL FILE HEADER (30 bytes + filename)
      const local = new Uint8Array(30 + entry.nameBytes.length);
      const lv = new DataView(local.buffer);

      lv.setUint32(0, 0x04034B50, true);  // Local header signature
      lv.setUint16(4, 20, true);          // Version needed: 2.0
      lv.setUint16(6, 0x0800, true);      // Bit 11 set: Force UTF-8 encoding for filenames
      lv.setUint16(8, entry.method, true);
      lv.setUint16(10, entry.dosTime, true);
      lv.setUint16(12, entry.dosDate, true);
      lv.setUint32(14, entry.crc, true);
      lv.setUint32(18, entry.compressedSize, true);
      lv.setUint32(22, entry.uncompressedSize, true);
      lv.setUint16(26, entry.nameBytes.length, true);
      lv.setUint16(28, 0, true);          // Extra field length = 0
      local.set(entry.nameBytes, 30);

      parts.push(local, entry.data);

      // 2. CENTRAL DIRECTORY RECORD (46 bytes + filename)
      const central = new Uint8Array(46 + entry.nameBytes.length);
      const cv = new DataView(central.buffer);

      cv.setUint32(0, 0x02014B50, true);  // Central directory file header signature
      cv.setUint16(4, 20, true);          // Version made by: DOS/FAT 2.0
      cv.setUint16(6, 20, true);          // Version needed: 2.0
      cv.setUint16(8, 0x0800, true);      // Bit 11 set: UTF-8
      cv.setUint16(10, entry.method, true);
      cv.setUint16(12, entry.dosTime, true);
      cv.setUint16(14, entry.dosDate, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.compressedSize, true);
      cv.setUint32(24, entry.uncompressedSize, true);
      cv.setUint16(28, entry.nameBytes.length, true);
      cv.setUint16(30, 0, true);          // Extra field length
      cv.setUint16(32, 0, true);          // Comment length
      cv.setUint16(34, 0, true);          // Disk start number
      cv.setUint16(36, 0, true);          // Internal attributes
      cv.setUint32(38, entry.isDir ? 0x10 : 0x20, true); // Attributes: Folder (0x10) / Archive File (0x20)
      cv.setUint32(42, offset, true);     // Relative offset of local header
      central.set(entry.nameBytes, 46);

      centralHeaders.push(central);
      offset += local.length + entry.data.length;
    }

    let centralDirSize = 0;
    for (const c of centralHeaders) {
      parts.push(c);
      centralDirSize += c.length;
    }

    // 3. END OF CENTRAL DIRECTORY (EOCD - 22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);   // EOCD signature
    ev.setUint16(4, 0, true);           // Disk number
    ev.setUint16(6, 0, true);           // Disk with start of central directory
    ev.setUint16(8, this.entries.length, true);   // Total entries on this disk
    ev.setUint16(10, this.entries.length, true);  // Total entries in central directory
    ev.setUint32(12, centralDirSize, true);       // Size of central directory
    ev.setUint32(16, offset, true);               // Offset of central directory
    ev.setUint16(20, 0, true);                    // ZIP comment length

    parts.push(eocd);

    return new Blob(parts, { type: mimeType });
  }

  /**
   * Triggers browser download.
   * Prioritizes Tampermonkey's `GM_download` API when available, falling back to standard DOM anchor.
   * @param {string} [filename='download.zip'] - Name of the downloaded file
   */
  download(filename = 'download.zip') {
    const mime = filename.endsWith('.epub') ? 'application/epub+zip' : 'application/zip';
    const blob = this.generateBlob(mime);

    if (typeof GM_download === 'function') {
      const url = URL.createObjectURL(blob);
      GM_download({
        url: url,
        name: filename,
        onload: () => URL.revokeObjectURL(url),
        onerror: () => this._fallbackDownload(blob, filename)
      });
      return;
    }

    this._fallbackDownload(blob, filename);
  }

  /**
   * Standard browser fallback download method using a virtual <a> tag.
   * @private
   */
  _fallbackDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 45000);
  }
}

// Universal module export (compatible with Browser Global, Node.js, and ES Modules)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UniversalZip;
} else if (typeof globalThis !== 'undefined') {
  globalThis.UniversalZip = UniversalZip;
}