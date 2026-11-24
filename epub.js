/**
 * UniversalEpub v3.0.1
 * Zero-dependency, CSP-Safe EPUB 3.0 (+ EPUB 2 NCX fallback) packager for Comics, Manga, Webtoons & Novels.
 *
 * Features:
 * - 100% Standalone: Built-in binary ZIP/EPUB packager (does NOT require ziplib.js).
 * - HTML5 Content (.html): Uses forgiving HTML5 documents instead of strict .xhtml.
 * - Dual TOC: Generates BOTH EPUB 3 `OEBPS/nav.html` AND EPUB 2 `OEBPS/toc.ncx` for maximum reader compatibility.
 * - Multi-Language Neutral: Defaults to 'und' (accepts 'vi', 'en', 'ja', 'ko', 'zh-CN', 'zh-TW', etc.).
 * - Strict Separation of CSS & Layout by Content Type ('comic' vs 'novel') and Reading Direction:
 *   + Comic : 'S'|'SCROLL' (Webtoon), 'PR'|'LTR' (L->R), 'PL'|'RTL' (R->L Manga)
 *   + Novel : 'LTR'|'HORIZONTAL' (Standard), 'RTL'|'VERTICAL' (Japanese Tategaki vertical-rl)
 * - Landscape / Double-Page Spread Support: Marks wide images with `rendition:page-spread-center`.
 *
 * @license MIT
 */
class UniversalEpub {
  /**
   * @param {Object} [options={}]
   * @param {string} [options.type='auto'] - 'comic' | 'novel' | 'auto'
   * @param {string} [options.title='Untitled'] - Book or chapter title
   * @param {string} [options.author=''] - Author / creator name
   * @param {string} [options.language='und'] - BCP-47 language code ('vi', 'en', 'ja', 'ko', 'zh-CN', 'zh-TW', 'und')
   * @param {string} [options.direction='auto'] - Comic: 'S'|'SCROLL'|'PR'|'LTR'|'PL'|'RTL' ; Novel: 'LTR'|'HORIZONTAL'|'RTL'|'VERTICAL'
   * @param {string} [options.id] - Unique identifier (auto-generated if omitted)
   * @param {number} [options.viewportWidth=1080] - Fixed-layout viewport width (Comic PR/PL)
   * @param {number} [options.viewportHeight=1536] - Fixed-layout viewport height (Comic PR/PL)
   */
  constructor(options = {}) {
    this.type           = String(options.type || 'auto').toLowerCase();
    this.title          = options.title || 'Untitled';
    this.author         = options.author || '';
    this.language       = options.language || 'und';
    this.rawDirection   = String(options.direction || 'auto').toUpperCase();
    this.id             = options.id || `urn:uuid:uepub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.viewportWidth  = options.viewportWidth || 1080;
    this.viewportHeight = options.viewportHeight || 1536;
    this.images         = [];
    this.chapters       = [];
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
    const m = mime.toLowerCase();
    if (m.includes('png')) return 'png';
    if (m.includes('webp')) return 'webp';
    if (m.includes('avif')) return 'avif';
    if (m.includes('gif')) return 'gif';
    return 'jpg';
  }

  static _pad(n, l = 4) {
    return String(n).padStart(l, '0');
  }

  static _base64ToUint8(b64) {
    const raw = atob(b64.replace(/\s/g, ''));
    const u8 = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) u8[i] = raw.charCodeAt(i);
    return u8;
  }

  // ========== CSS TEMPLATES (TÁCH RIÊNG TỪNG LOẠI & HƯỚNG ĐỌC) ==========
  static _getCss(resolvedType, resolvedDir) {
    if (resolvedType === 'comic') {
      if (resolvedDir === 'SCROLL') {
        return `html,body{margin:0;padding:0;background:#000;width:100%}
.webtoon-wrap{display:flex;flex-direction:column;align-items:center;width:100%;margin:0;padding:0}
.webtoon-wrap img{display:block;width:100%;height:auto;margin:0;padding:0;border:0}`;
      }
      return `html,body{margin:0;padding:0;width:100%;height:100%;background:#000;overflow:hidden}
.comic-page{width:100%;height:100%;display:flex;align-items:center;justify-content:center;margin:0;padding:0}
.comic-page img{max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain;display:block;margin:0 auto}`;
    }

    if (resolvedDir === 'RTL') {
      return `html{writing-mode:vertical-rl;-webkit-writing-mode:vertical-rl;text-orientation:mixed}
body{margin:0;padding:1.5em 1.2em;line-height:1.9;font-family:"Yu Mincho","Hiragino Mincho ProN","Noto Serif JP",serif}
.ch-header{margin-left:1.5em;padding-left:.8em;border-left:1px solid #888;text-align:center}
.ch-header h1{font-size:1.25em;margin:0 0 0 .4em}
.ch-header h2{font-size:1em;margin:0;opacity:.8;font-weight:normal}
p{margin:0 .4em;text-indent:1em}
ruby{ruby-position:over}
img{display:block;writing-mode:horizontal-tb;max-height:92vh;max-width:92vw;width:auto;height:auto;margin:auto;object-fit:contain}`;
    }

    return `html,body{margin:0;padding:0;writing-mode:horizontal-tb;line-height:1.85;font-family:serif}
body{padding:1.2em 1.4em}
.ch-header{text-align:center;margin:0 0 1.8em;padding-bottom:.9em;border-bottom:1px solid #888}
.ch-header h1{font-size:1.3em;margin:0 0 .35em}
.ch-header h2{font-size:1em;margin:0;opacity:.8;font-weight:normal}
p{margin:.75em 0;text-indent:1em;text-align:justify}
img{display:block;max-width:100%;height:auto;margin:1.2em auto;object-fit:contain}`;
  }

  // ========== PUBLIC API: COMIC / WEBTOON ==========
  async addImage(data, mime = 'image/jpeg', meta = {}) {
    let u8;
    if (data instanceof Uint8Array) u8 = data;
    else if (data instanceof ArrayBuffer) u8 = new Uint8Array(data);
    else if (data instanceof Blob || (typeof File !== 'undefined' && data instanceof File)) {
      if (!mime && data.type) mime = data.type;
      u8 = new Uint8Array(await data.arrayBuffer());
    } else {
      throw new Error('[UniversalEpub] Unsupported image data type');
    }

    const isLandscape = Boolean(
      meta.isLandscape || (meta.width && meta.height && meta.width > meta.height)
    );
    this.images.push({ u8, mime: mime || 'image/jpeg', isLandscape });
    return this;
  }

  async addImages(list) {
    if (!Array.isArray(list)) return this;
    for (const item of list) {
      await this.addImage(item.u8 || item.data, item.mime, {
        isLandscape: item.isLandscape,
        width: item.width,
        height: item.height
      });
    }
    return this;
  }

  // ========== PUBLIC API: NOVEL (HTML TEXT) ==========
  addChapter(ch = {}) {
    this.chapters.push({
      title: ch.title || `Chapter ${this.chapters.length + 1}`,
      html:  ch.html || '',
      css:   ch.css || ''
    });
    return this;
  }

  // ========== BUILD EPUB BLOB ==========
  async generateBlob() {
    if (!this.images.length && !this.chapters.length) {
      throw new Error('[UniversalEpub] No images or chapters added');
    }

    const resolvedType = this.type === 'auto'
      ? (this.chapters.length > 0 ? 'novel' : 'comic')
      : this.type;

    let resolvedDir;
    if (resolvedType === 'comic') {
      if (this.rawDirection === 'PL' || this.rawDirection === 'RTL') resolvedDir = 'RTL';
      else if (this.rawDirection === 'PR' || this.rawDirection === 'LTR') resolvedDir = 'LTR';
      else resolvedDir = 'SCROLL';
    } else {
      resolvedDir = (this.rawDirection === 'RTL' || this.rawDirection === 'VERTICAL' || this.rawDirection === 'PL')
        ? 'RTL'
        : 'LTR';
    }

    const enc       = new TextEncoder();
    const entries   = [];
    const now       = UniversalEpub._toDosTime(new Date());
    const safeTitle = UniversalEpub._escapeXml(this.title);
    const safeId    = UniversalEpub._escapeXml(this.id);
    const safeLang  = UniversalEpub._escapeXml(this.language);

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
        nameBytes: enc.encode(path),
        data: finalBytes,
        uncompressedSize: rawBytes.length,
        compressedSize: finalBytes.length,
        crc: UniversalEpub._crc32(rawBytes),
        method
      });
    };

    // 1. mimetype (MUST be first & uncompressed)
    await pushEntry('mimetype', 'application/epub+zip', false);

    // 2. META-INF/container.xml
    await pushEntry('META-INF/container.xml',
`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`, true);

    const manifest = [
      `<item id="css" href="style.css" media-type="text/css"/>`,
      `<item id="nav" href="nav.html" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
    ];
    const spine = [];
    const tocEntries = []; // [{ title, href }] dùng chung cho cả nav.html và toc.ncx
    const ppd = resolvedDir === 'RTL' ? 'rtl' : 'ltr';
    let renditionMeta = '';

    // 3. CSS & Content (.html)
    if (resolvedType === 'novel') {
      const extraCss = this.chapters.map(c => c.css).filter(Boolean).join('\n');
      await pushEntry('OEBPS/style.css', UniversalEpub._getCss('novel', resolvedDir) + '\n' + extraCss, true);

      const parser = new DOMParser();
      let imgSeq = 0;

      for (let i = 0; i < this.chapters.length; i++) {
        const ch = this.chapters[i];
        const chFile = `ch_${UniversalEpub._pad(i + 1)}.html`;
        const doc = parser.parseFromString(`<div>${ch.html}</div>`, 'text/html');
        const root = doc.body.firstElementChild;

        root.querySelectorAll('script, style').forEach(el => el.remove());

        for (const img of Array.from(root.querySelectorAll('img'))) {
          const src = img.getAttribute('src') || '';
          const m = src.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
          if (m) {
            imgSeq++;
            const mime = m[1].toLowerCase() === 'image/pjpeg' ? 'image/jpeg' : m[1].toLowerCase();
            const ext = UniversalEpub._extFromMime(mime);
            const href = `images/img_${UniversalEpub._pad(imgSeq)}.${ext}`;
            await pushEntry(`OEBPS/${href}`, UniversalEpub._base64ToUint8(m[2]), false);
            const coverProp = imgSeq === 1 ? ' properties="cover-image"' : '';
            manifest.push(`<item id="img_${imgSeq}" href="${href}" media-type="${mime}"${coverProp}/>`);
            img.setAttribute('src', href);
            img.removeAttribute('style');
          }
        }

        const safeChTitle = UniversalEpub._escapeXml(ch.title);
        const htmlDoc =
`<!DOCTYPE html>
<html lang="${safeLang}">
<head>
  <meta charset="UTF-8">
  <title>${safeChTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css">
</head>
<body>
  <header class="ch-header">
    <h1>${safeTitle}</h1>
    <h2>${safeChTitle}</h2>
  </header>
  <article class="ch-body">
    ${root.innerHTML}
  </article>
</body>
</html>`;
        await pushEntry(`OEBPS/${chFile}`, htmlDoc, true);
        manifest.push(`<item id="ch_${i + 1}" href="${chFile}" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="ch_${i + 1}"/>`);
        tocEntries.push({ title: safeChTitle, href: chFile });
      }

      renditionMeta = `    <meta property="rendition:layout">reflowable</meta>`;
    } else {
      await pushEntry('OEBPS/style.css', UniversalEpub._getCss('comic', resolvedDir), true);

      const imgEntries = [];
      for (let i = 0; i < this.images.length; i++) {
        const img  = this.images[i];
        const ext  = UniversalEpub._extFromMime(img.mime);
        const href = `images/${UniversalEpub._pad(i + 1)}.${ext}`;
        imgEntries.push({ href, isLandscape: img.isLandscape });
        await pushEntry(`OEBPS/${href}`, img.u8, false);
        const coverAttr = i === 0 ? ' properties="cover-image"' : '';
        manifest.push(`<item id="img_${i + 1}" href="${href}" media-type="${img.mime}"${coverAttr}/>`);
      }

      if (resolvedDir === 'SCROLL') {
        const tags = imgEntries.map((it, i) => `    <img src="${it.href}" alt="p${i + 1}">`).join('\n');
        const htmlDoc =
`<!DOCTYPE html>
<html lang="${safeLang}">
<head>
  <meta charset="UTF-8">
  <title>${safeTitle}</title>
  <link rel="stylesheet" type="text/css" href="style.css">
</head>
<body>
  <div class="webtoon-wrap">
${tags}
  </div>
</body>
</html>`;
        await pushEntry('OEBPS/index.html', htmlDoc, true);
        manifest.push(`<item id="p_scroll" href="index.html" media-type="application/xhtml+xml"/>`);
        spine.push(`<itemref idref="p_scroll"/>`);
        tocEntries.push({ title: safeTitle, href: 'index.html' });
        renditionMeta = `    <meta property="rendition:layout">reflowable</meta>\n    <meta property="rendition:flow">scrolled-continuous</meta>`;
      } else {
        for (let i = 0; i < imgEntries.length; i++) {
          const it = imgEntries[i];
          const pFile = `p_${UniversalEpub._pad(i + 1)}.html`;
          const htmlDoc =
`<!DOCTYPE html>
<html lang="${safeLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${this.viewportWidth}, height=${this.viewportHeight}">
  <title>${safeTitle} - ${i + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css">
</head>
<body>
  <div class="comic-page">
    <img src="${it.href}" alt="p${i + 1}">
  </div>
</body>
</html>`;
          await pushEntry(`OEBPS/${pFile}`, htmlDoc, true);
          manifest.push(`<item id="p_${i + 1}" href="${pFile}" media-type="application/xhtml+xml"/>`);
          const spreadAttr = it.isLandscape ? ' properties="rendition:page-spread-center"' : '';
          spine.push(`<itemref idref="p_${i + 1}"${spreadAttr}/>`);
        }
        tocEntries.push({ title: safeTitle, href: 'p_0001.html' });
        renditionMeta = `    <meta property="rendition:layout">pre-paginated</meta>\n    <meta property="rendition:orientation">auto</meta>\n    <meta property="rendition:spread">auto</meta>`;
      }
    }

    // 4. OEBPS/nav.html (EPUB 3 TOC)
    const navItems = tocEntries.map(t => `<li><a href="${t.href}">${t.title}</a></li>`);
    await pushEntry('OEBPS/nav.html',
`<!DOCTYPE html>
<html lang="${safeLang}" xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="UTF-8"><title>TOC</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>${safeTitle}</h1>
    <ol>
      ${navItems.join('\n      ')}
    </ol>
  </nav>
</body>
</html>`, true);

    // 5. OEBPS/toc.ncx (EPUB 2 NCX TOC - tương thích rộng rãi các trình đọc)
    const ncxPoints = tocEntries.map((t, idx) =>
`    <navPoint id="navPoint-${idx + 1}" playOrder="${idx + 1}">
      <navLabel><text>${t.title}</text></navLabel>
      <content src="${t.href}"/>
    </navPoint>`
    ).join('\n');

    await pushEntry('OEBPS/toc.ncx',
`<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${safeId}"/>
    <meta name="dtb:depth" content="1"/>
    <meta name="dtb:totalPageCount" content="0"/>
    <meta name="dtb:maxPageNumber" content="0"/>
  </head>
  <docTitle><text>${safeTitle}</text></docTitle>
  <navMap>
${ncxPoints}
  </navMap>
</ncx>`, true);

    // 6. OEBPS/content.opf
    const authorMeta = this.author ? `\n    <dc:creator>${UniversalEpub._escapeXml(this.author)}</dc:creator>` : '';
    await pushEntry('OEBPS/content.opf',
`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" prefix="rendition: http://www.idpf.org/vocab/rendition/#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${safeId}</dc:identifier>
    <dc:title>${safeTitle}</dc:title>${authorMeta}
    <dc:language>${safeLang}</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
${renditionMeta}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx" page-progression-direction="${ppd}">
    ${spine.join('\n    ')}
  </spine>
</package>`, true);

    // 7. Assemble ZIP binary
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
    for (const c of centralHeaders) { parts.push(c); centralDirSize += c.length; }

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
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 45000);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = UniversalEpub;
} else {
  if (typeof globalThis !== 'undefined') globalThis.UniversalEpub = UniversalEpub;
  if (typeof unsafeWindow !== 'undefined') unsafeWindow.UniversalEpub = UniversalEpub;
}