/**
 * UniversalEpub - Zero-dependency, CSP-Safe EPUB 3.0 packager for Comics, Manga & Webtoons.
 *
 * Features:
 * - 100% Standalone: Built-in binary ZIP/EPUB packager (does NOT require ziplib.js or external workers).
 * - IDPF EPUB 3.0 Compliant: Uncompressed "mimetype" at index 0, UTF-8 Bit 11, native Deflate-raw for XML/XHTML/CSS.
 * - Image Optimized: Stores pre-compressed images (.jpg, .png, .webp, .avif, .gif) without re-compression.
 * - Multi-Direction Support:
 *   - 'S' / 'SCROLL' : Webtoon continuous vertical scroll (reflowable + scrolled-continuous).
 *   - 'PR' / 'LTR'   : Fixed-layout Left-to-Right (Korean manhwa / Western comics).
 *   - 'PL' / 'RTL'   : Fixed-layout Right-to-Left (Traditional Japanese manga).
 *
 * @license MIT
 * @version 2.0.0
 */
class UniversalEpub {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.title='Untitled'] - Book or chapter title
   * @param {string} [options.author=''] - Author / creator name
   * @param {string} [options.language='ko'] - ISO language code ('ko', 'ja', 'vi', 'en'...)
   * @param {string} [options.direction='S'] - 'S'|'SCROLL' (Webtoon), 'PR'|'LTR' (L->R), 'PL'|'RTL' (R->L)
   * @param {string} [options.id] - Unique book identifier (auto-generated if omitted)
   * @param {number} [options.viewportWidth=1080] - Viewport width for fixed-layout (PR/PL)
   * @param {number} [options.viewportHeight=1536] - Viewport height for fixed-layout (PR/PL)
   */
  constructor(options = {}) {
    this.title          = options.title || 'Untitled';
    this.author         = options.author || '';
    this.language       = options.language || 'ko';
    this.mode           = UniversalEpub._normalizeDirection(options.direction);
    this.id             = options.id || `urn:uuid:uepub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.viewportWidth  = options.viewportWidth || 1080;
    this.viewportHeight = options.viewportHeight || 1536;
    this.images         = [];
  }

  // ========== INTERNAL BINARY PACKAGER ==========
  static _crcTable = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[i] = c >>> 0;
    }
    return table;
  })();

  static _crc32(buf) {
    let crc = -1;
    for (let i = 0; i < buf.length; i++) {
      crc = (crc >>> 8) ^ UniversalEpub._crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ -1) >>> 0;
  }

  static _toDosTime(d = new Date()) {
    const year = Math.max(1980, d.getFullYear());
    return {
      dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
      dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)
    };
  }

  static async _deflateRaw(bytes) {
    if (typeof CompressionStream !== 'undefined') {
      try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        writer.write(bytes);
        writer.close();
        return new Uint8Array(await new Response(cs.readable).arrayBuffer());
      } catch (_) {
        return bytes;
      }
    }
    return bytes;
  }

  static _normalizeDirection(dir) {
    const d = String(dir || 'S').toUpperCase();
    if (d === 'PL' || d === 'RTL') return 'RTL';
    if (d === 'PR' || d === 'LTR') return 'LTR';
    return 'SCROLL';
  }

  static _escapeXml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  static _extFromMime(mime) {
    if (!mime) return 'jpg';
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('avif')) return 'avif';
    if (mime.includes('gif')) return 'gif';
    return 'jpg';
  }

  static _pad(n, l = 4) {
    return String(n).padStart(l, '0');
  }

  // ========== PUBLIC API ==========

  /**
   * Adds a single image to the EPUB in order.
   * @param {Uint8Array|ArrayBuffer|Blob|File} data - Binary image data
   * @param {string} [mime='image/jpeg'] - Image MIME type
   * @returns {Promise<UniversalEpub>}
   */
  async addImage(data, mime = 'image/jpeg') {
    let u8;
    if (data instanceof Uint8Array) {
      u8 = data;
    } else if (data instanceof ArrayBuffer) {
      u8 = new Uint8Array(data);
    } else if (data instanceof Blob || (typeof File !== 'undefined' && data instanceof File)) {
      if (!mime && data.type) mime = data.type;
      u8 = new Uint8Array(await data.arrayBuffer());
    } else {
      throw new Error('[UniversalEpub] Unsupported image data type');
    }
    this.images.push({ u8, mime: mime || 'image/jpeg' });
    return this;
  }

  /**
   * Adds an array of images: [{ u8|data, mime }]
   * @param {Array<{u8?: Uint8Array|ArrayBuffer|Blob, data?: Uint8Array|ArrayBuffer|Blob, mime?: string}>} list
   * @returns {Promise<UniversalEpub>}
   */
  async addImages(list) {
    if (!Array.isArray(list)) return this;
    for (const item of list) {
      await this.addImage(item.u8 || item.data, item.mime);
    }
    return this;
  }

  /**
   * Packages all added images into a valid EPUB 3.0 Blob.
   * @returns {Promise<Blob>}
   */
  async generateBlob() {
    if (!this.images.length) {
      throw new Error('[UniversalEpub] No images added to package');
    }

    const enc       = new TextEncoder();
    const entries   = [];
    const now       = UniversalEpub._toDosTime(new Date());
    const isScroll  = this.mode === 'SCROLL';
    const ppd       = this.mode === 'RTL' ? 'rtl' : 'ltr';
    const safeTitle = UniversalEpub._escapeXml(this.title);
    const safeId    = UniversalEpub._escapeXml(this.id);

    const pushEntry = async (path, content, compress = true) => {
      const rawBytes = typeof content === 'string' ? enc.encode(content) : content;
      let finalBytes = rawBytes;
      let method = 0;

      if (compress && rawBytes.length > 0) {
        const deflated = await UniversalEpub._deflateRaw(rawBytes);
        if (deflated.length < rawBytes.length) {
          finalBytes = deflated;
          method = 8;
        }
      }

      entries.push({
        nameBytes:        enc.encode(path),
        data:             finalBytes,
        uncompressedSize: rawBytes.length,
        compressedSize:   finalBytes.length,
        crc:              UniversalEpub._crc32(rawBytes),
        method
      });
    };

    // 1. mimetype (MUST be first & uncompressed per EPUB spec)
    await pushEntry('mimetype', 'application/epub+zip', false);

    // 2. META-INF/container.xml
    await pushEntry('META-INF/container.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`, true);

    // 3. OEBPS/style.css
    const css = isScroll
      ? `html,body{margin:0;padding:0;background:#000;width:100%}.webtoon{display:flex;flex-direction:column;align-items:center;width:100%;margin:0;padding:0}.webtoon img{display:block;width:100%;height:auto;margin:0;padding:0;border:0}`
      : `html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}.page{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.page img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block}`;
    await pushEntry('OEBPS/style.css', css, true);

    const manifest = [
      `<item id="css" href="style.css" media-type="text/css"/>`,
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
    ];
    const spine = [];
    const imgPaths = [];

    // 4. Images (stored uncompressed to avoid CPU/RAM spike)
    for (let i = 0; i < this.images.length; i++) {
      const img  = this.images[i];
      const ext  = UniversalEpub._extFromMime(img.mime);
      const href = `images/${UniversalEpub._pad(i + 1)}.${ext}`;
      imgPaths.push(href);

      await pushEntry(`OEBPS/${href}`, img.u8, false);
      const coverAttr = i === 0 ? ' properties="cover-image"' : '';
      manifest.push(`<item id="img_${i + 1}" href="${href}" media-type="${img.mime}"${coverAttr}/>`);
    }

    // 5. XHTML pages
    if (isScroll) {
      const imgTags = imgPaths.map((h, i) => `    <img src="${h}" alt="p${i + 1}"/>`).join('\n');
      await pushEntry('OEBPS/index.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8"/>
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <div class="webtoon">
${imgTags}
  </div>
</body>
</html>`, true);
      manifest.push(`<item id="p_scroll" href="index.xhtml" media-type="application/xhtml+xml"/>`);
      spine.push(`<itemref idref="p_scroll"/>`);
    } else {
      for (let i = 0; i < imgPaths.length; i++) {
        const pFile = `p_${UniversalEpub._pad(i + 1)}.xhtml`;
        await pushEntry(`OEBPS/${pFile}`,
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=${this.viewportWidth}, height=${this.viewportHeight}"/>
  <title>${safeTitle} - ${i + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
  <div class="page">
    <img src="${imgPaths[i]}" alt="p${i + 1}"/>
  </div>
</body>
</html>`, true);
        manifest.push(`<item id="p_${i + 1}" href="${pFile}" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="p_${i + 1}"/>`);
      }
    }

    // 6. OEBPS/nav.xhtml
    const firstHref = isScroll ? 'index.xhtml' : 'p_0001.xhtml';
    await pushEntry('OEBPS/nav.xhtml',
`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"/><title>TOC</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${safeTitle}</h1>
    <ol><li><a href="${firstHref}">${safeTitle}</a></li></ol>
  </nav>
</body>
</html>`, true);

    // 7. OEBPS/content.opf
    const authorMeta = this.author ? `\n    <dc:creator>${UniversalEpub._escapeXml(this.author)}</dc:creator>` : '';
    const renditionMeta = isScroll
      ? `    <meta property="rendition:layout">reflowable</meta>
    <meta property="rendition:flow">scrolled-continuous</meta>`
      : `    <meta property="rendition:layout">pre-paginated</meta>
    <meta property="rendition:orientation">auto</meta>
    <meta property="rendition:spread">auto</meta>`;

    await pushEntry('OEBPS/content.opf',
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${safeId}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>${authorMeta}
    <dc:language>${UniversalEpub._escapeXml(this.language)}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
${renditionMeta}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine page-progression-direction="${ppd}">
    ${spine.join('\n    ')}
  </spine>
</package>`, true);

    // 8. Assemble ZIP binary
    const parts = [];
    const centralHeaders = [];
    let offset = 0;

    for (const entry of entries) {
      const local = new Uint8Array(30 + entry.nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034B50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, entry.method, true);
      lv.setUint16(10, now.dosTime, true);
      lv.setUint16(12, now.dosDate, true);
      lv.setUint32(14, entry.crc, true);
      lv.setUint32(18, entry.compressedSize, true);
      lv.setUint32(22, entry.uncompressedSize, true);
      lv.setUint16(26, entry.nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(entry.nameBytes, 30);

      parts.push(local, entry.data);

      const central = new Uint8Array(46 + entry.nameBytes.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014B50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, entry.method, true);
      cv.setUint16(12, now.dosTime, true);
      cv.setUint16(14, now.dosDate, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.compressedSize, true);
      cv.setUint32(24, entry.uncompressedSize, true);
      cv.setUint16(28, entry.nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0x20, true);
      cv.setUint32(42, offset, true);
      central.set(entry.nameBytes, 46);

      centralHeaders.push(central);
      offset += local.length + entry.data.length;
    }

    let centralDirSize = 0;
    for (const c of centralHeaders) {
      parts.push(c);
      centralDirSize += c.length;
    }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054B50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralDirSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);
    parts.push(eocd);

    return new Blob(parts, { type: 'application/epub+zip' });
  }

  /**
   * Generates the EPUB and triggers download (GM_download if available, else DOM fallback).
   * @param {string} [filename='book.epub']
   */
  async download(filename = 'book.epub') {
    if (!filename.toLowerCase().endsWith('.epub')) filename += '.epub';
    const blob = await this.generateBlob();

    if (typeof GM_download === 'function') {
      const url = URL.createObjectURL(blob);
      GM_download({
        url,
        name: filename,
        onload: () => URL.revokeObjectURL(url),
        onerror: () => this._fallbackDownload(blob, filename)
      });
      return;
    }
    this._fallbackDownload(blob, filename);
  }

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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = UniversalEpub;
} else {
  if (typeof globalThis !== 'undefined') globalThis.UniversalEpub = UniversalEpub;
  if (typeof unsafeWindow !== 'undefined') unsafeWindow.UniversalEpub = UniversalEpub;
}