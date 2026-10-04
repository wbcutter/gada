/**
 * ============================================================================
 * Saver.js - Core Engine Bóc Tách, Bơm Link DOM & Tối Ưu RAM Cho In Ấn
 * ============================================================================
 * 1. DOM Injection: Bơm trực tiếp `data-saver-src`, `data-saver-blob` vào DOM.
 * 2. Quality 1.0: Canvas xuất ảnh JPEG với quality = 1.0; giữ nguyên stream gốc.
 * 3. CDN Uncloaker: Gỡ bỏ query resize (?w=, ?h=, -thumb, -scaled) để lấy ảnh gốc.
 * 4. Blob Vault: Hook & chặn triệt để URL.revokeObjectURL.
 * 5. MutationObserver: Tự động phát hiện và bơm link cho ảnh lazy-load mới xuất hiện.
 */

(function (global, factory) {
    if (typeof module === 'object' && typeof module.exports === 'object') {
        module.exports = factory();
    } else {
        global.Saver = factory();
    }
})(typeof window !== 'undefined' ? window : this, function () {
    'use strict';

    // ========================================================================
    // 1. BLOB VAULT: Chặn revokeObjectURL & Lưu trữ Blob tham chiếu
    // ========================================================================
    const BlobVault = (() => {
        const vault = new Map();
        const rawCreate = URL.createObjectURL.bind(URL);
        const rawRevoke = URL.revokeObjectURL.bind(URL);
        let locked = true;

        URL.createObjectURL = function (blob) {
            const url = rawCreate(blob);
            if (blob instanceof Blob) {
                vault.set(url, blob);
            }
            return url;
        };

        URL.revokeObjectURL = function (url) {
            if (locked && vault.has(url)) {
                // Chặn web hủy blob url
                return;
            }
            rawRevoke(url);
        };

        return {
            get: (url) => vault.get(url) || null,
            has: (url) => vault.has(url),
            save: (url, blob) => { if (blob instanceof Blob) vault.set(url, blob); },
            release: (url) => {
                if (vault.has(url)) {
                    vault.delete(url);
                    rawRevoke(url);
                }
            },
            clear: () => {
                for (const url of vault.keys()) rawRevoke(url);
                vault.clear();
            },
            setLock: (val) => { locked = !!val; }
        };
    })();

    // ========================================================================
    // 2. CONVERTER & MAGIC BYTES (Bảo toàn 100% định dạng gốc)
    // ========================================================================
    const Converter = (() => {
        const MIME_MAP = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'image/avif': 'avif',
            'image/bmp': 'bmp',
            'image/svg+xml': 'svg'
        };

        function base64ToBlob(dataUrl) {
            if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
                return null;
            }
            try {
                const parts = dataUrl.split(',');
                const mimeMatch = parts[0].match(/:(.*?);/);
                const mime = mimeMatch ? mimeMatch[1] : 'image/jpeg';
                const bstr = window.atob(parts[1]);
                let n = bstr.length;
                const u8arr = new Uint8Array(n);
                while (n--) {
                    u8arr[n] = bstr.charCodeAt(n);
                }
                return new Blob([u8arr], { type: mime });
            } catch (e) {
                console.warn('[Saver.js] Base64 decode failed:', e);
                return null;
            }
        }

        async function inspectBlob(blob) {
            if (!blob || !(blob instanceof Blob)) return null;
            try {
                const buffer = await blob.slice(0, 16).arrayBuffer();
                const u8 = new Uint8Array(buffer);

                if (u8[0] === 0xFF && u8[1] === 0xD8 && u8[2] === 0xFF) return { mime: 'image/jpeg', ext: 'jpg' };
                if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4E && u8[3] === 0x47) return { mime: 'image/png', ext: 'png' };
                if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
                if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[8] === 0x57 && u8[9] === 0x45 && u8[10] === 0x42) return { mime: 'image/webp', ext: 'webp' };
                if (u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
                    const brand = String.fromCharCode(u8[8], u8[9], u8[10], u8[11]);
                    if (brand === 'avif' || brand === 'avis') return { mime: 'image/avif', ext: 'avif' };
                }
                if (u8[0] === 0x42 && u8[1] === 0x4D) return { mime: 'image/bmp', ext: 'bmp' };
            } catch (e) {}

            const fallbackMime = blob.type || 'image/jpeg';
            return { mime: fallbackMime, ext: MIME_MAP[fallbackMime] || 'jpg' };
        }

        return { base64ToBlob, inspectBlob, MIME_MAP };
    })();

    // ========================================================================
    // 3. CANVAS HARVESTER: Quality 1.0 & Fallback đa tầng
    // ========================================================================
    const CanvasHarvester = (() => {
        if (typeof CanvasRenderingContext2D !== 'undefined') {
            const rawDraw = CanvasRenderingContext2D.prototype.drawImage;
            CanvasRenderingContext2D.prototype.drawImage = function (...args) {
                const srcImg = args[0];
                if (srcImg && (srcImg.currentSrc || srcImg.src)) {
                    this.canvas.dataset.originalSource = srcImg.currentSrc || srcImg.src;
                }
                return rawDraw.apply(this, args);
            };
        }

        /**
         * Canvas to Blob với QUALITY = 1.0 (Không nén giảm chất lượng)
         */
        async function toBlob(canvas, quality = 1.0) {
            if (!canvas || canvas.width === 0 || canvas.height === 0) return null;

            // 1. Thử canvas.toBlob('image/jpeg', 1.0)
            if (typeof canvas.toBlob === 'function') {
                const blobJpg = await new Promise((resolve) => {
                    try {
                        canvas.toBlob((b) => resolve(b), 'image/jpeg', quality);
                    } catch (e) {
                        resolve(null);
                    }
                });
                if (blobJpg) return blobJpg;
            }

            // 2. Fallback: canvas.toDataURL('image/jpeg', 1.0) -> Base64 to Blob
            try {
                const dataUrlJpg = canvas.toDataURL('image/jpeg', quality);
                const blob = Converter.base64ToBlob(dataUrlJpg);
                if (blob) return blob;
            } catch (e) {}

            // 3. Fallback: canvas.toDataURL('image/png') -> Base64 to Blob (PNG mặc định lossless)
            try {
                const dataUrlPng = canvas.toDataURL('image/png');
                const blob = Converter.base64ToBlob(dataUrlPng);
                if (blob) return blob;
            } catch (e) {
                console.warn('[Saver.js] Canvas tainted CORS.');
            }

            // 4. Fallback: Lấy URL nguồn gốc đã vẽ lên canvas (nếu bắt được hook)
            if (canvas.dataset && canvas.dataset.originalSource) {
                return canvas.dataset.originalSource;
            }

            return null;
        }

        return { toBlob };
    })();

    // ========================================================================
    // 4. URL UNCLOAKER: Gỡ bọc link thumbnail/CDN của Picviewer CE+
    // ========================================================================
    const UrlUncloaker = (() => {
        const LAZY_ATTRS = [
            "data-lazy-src", "data-src", "data-original", "data-url",
            "data-orig-file", "zoomfile", "file", "real_src", "src2",
            "data-lazyload", "data-ks-lazyload", "data-actualsrc", "data-cover",
            "data-imageurl", "origin-src", "data-defer-src", "data-high-res-src"
        ];

        // Quy tắc gỡ các query/hậu tố resize ảnh phổ biến trên web truyện/gallery
        const UNCLOAK_PATTERNS = [
            { reg: /[\?&](width|w|height|h|resize|quality|q|size|maxwidth)=\d+/gi, rep: '' },
            { reg: /-(thumb|small|thumbnail|scaled|min|medium|mobile)(\.\w{3,4})$/i, rep: '$2' },
            { reg: /\/thumbs?\//i, rep: '/original/' },
            { reg: /\/medium\//i, rep: '/large/' },
            { reg: /(=w\d+-h\d+.*$)|(=s\d+.*$)/i, rep: '=s0' } // Google/Blogger
        ];

        function uncloakUrl(url) {
            if (!url || typeof url !== 'string' || url.startsWith('data:') || url.startsWith('blob:')) {
                return url;
            }
            let cleaned = url;
            for (const p of UNCLOAK_PATTERNS) {
                cleaned = cleaned.replace(p.reg, p.rep);
            }
            return cleaned;
        }

        function extractBestUrl(el) {
            if (!el || el.nodeType !== 1) return null;

            // 1. Kiểm tra parent <a> (Web truyện thường bọc thumbnail trong link trỏ đến ảnh gốc)
            const parentA = el.closest('a[href]');
            if (parentA && parentA.href && /\.(jpe?g|png|webp|avif|gif|bmp)(\?.*)?$/i.test(parentA.href)) {
                return uncloakUrl(parentA.href);
            }

            // 2. Quét thuộc tính lazy-load
            for (const attr of LAZY_ATTRS) {
                const val = el.getAttribute(attr);
                if (val && !val.startsWith('data:image/svg')) {
                    return uncloakUrl(val.trim());
                }
            }

            // 3. Quét srcset (lấy độ phân giải cao nhất)
            if (el.srcset) {
                const list = el.srcset.split(/,\s*/).map(s => s.trim().split(/\s+/));
                if (list.length > 0) {
                    return uncloakUrl(list[list.length - 1][0]);
                }
            }

            // 4. Link src hoặc currentSrc hiện thời
            const current = el.currentSrc || el.src;
            if (current) return uncloakUrl(current);

            return null;
        }

        return { uncloakUrl, extractBestUrl };
    })();

    // ========================================================================
    // 5. DOM ENRICHER (TÍNH NĂNG ĂN TIỀN: BƠM LINK & BLOB NGƯỢC VÀO DOM)
    // ========================================================================
    const DOMEnricher = (() => {
        /**
         * Xử lý một Node: Giải mã và bơm ngay kết quả vào DOM
         */
        async function enrichElement(el) {
            if (!el || el.nodeType !== 1 || el.dataset.saverReady === 'true') return null;

            const tag = el.tagName.toUpperCase();
            let finalSrc = null;
            let finalBlob = null;
            let sourceType = 'unknown';

            // --- Case A: Thẻ Canvas ---
            if (tag === 'CANVAS') {
                sourceType = 'canvas';
                const blobOrUrl = await CanvasHarvester.toBlob(el, 1.0);
                if (blobOrUrl instanceof Blob) {
                    finalBlob = blobOrUrl;
                    finalSrc = URL.createObjectURL(finalBlob);
                } else if (typeof blobOrUrl === 'string') {
                    finalSrc = blobOrUrl;
                }
            }
            // --- Case B: Thẻ <img> ---
            else if (tag === 'IMG') {
                const current = el.src || '';

                // Nếu ảnh đang bị nhúng chuỗi Base64
                if (current.startsWith('data:')) {
                    sourceType = 'base64';
                    finalBlob = Converter.base64ToBlob(current);
                    if (finalBlob) {
                        finalSrc = URL.createObjectURL(finalBlob);
                        // Thay thế trực tiếp src để giải phóng RAM của thẻ img
                        el.src = finalSrc;
                    }
                }
                // Nếu là ảnh thông thường hoặc lazy-load
                else {
                    sourceType = 'img';
                    finalSrc = UrlUncloaker.extractBestUrl(el);
                    // Nếu là blob url có trong Vault
                    if (finalSrc && BlobVault.has(finalSrc)) {
                        finalBlob = BlobVault.get(finalSrc);
                    }
                }
            }
            // --- Case C: CSS Background Image ---
            else {
                const style = window.getComputedStyle(el);
                const bg = style.backgroundImage;
                if (bg && bg !== 'none') {
                    const match = /url\(\s*["']?([^ad\s'"#].+?)["']?\s*\)/i.exec(bg);
                    if (match && match[1]) {
                        sourceType = 'bg';
                        finalSrc = UrlUncloaker.uncloakUrl(match[1].replace(/\\"/g, '"'));
                    }
                }
            }

            // ================================================================
            // BƠM DỮ LIỆU NGƯỢC VÀO DOM (DOM INJECTION)
            // ================================================================
            if (finalSrc || finalBlob) {
                el.dataset.saverReady = 'true';
                el.dataset.saverType = sourceType;
                
                if (finalSrc) {
                    el.dataset.saverSrc = finalSrc;
                }
                if (finalBlob) {
                    const bUrl = finalSrc && finalSrc.startsWith('blob:') ? finalSrc : URL.createObjectURL(finalBlob);
                    el.dataset.saverBlob = bUrl;
                    BlobVault.save(bUrl, finalBlob);
                }

                // Gắn Object trực tiếp vào DOM node để script khác truy xuất nhanh
                el._saver = {
                    src: finalSrc,
                    blob: finalBlob,
                    type: sourceType,
                    element: el
                };

                return el._saver;
            }

            return null;
        }

        /**
         * Quét sâu toàn bộ cây DOM (bao gồm cả Shadow DOM) và bơm link
         */
        async function enrichAll(root = document.body) {
            const nodes = [];

            function traverse(node) {
                if (!node || node.nodeType !== 1) return;
                const tag = node.tagName.toUpperCase();

                if (tag === 'IMG' || tag === 'CANVAS') {
                    nodes.push(node);
                } else {
                    const style = window.getComputedStyle(node);
                    if (style.backgroundImage && style.backgroundImage !== 'none') {
                        nodes.push(node);
                    }
                }

                if (node.shadowRoot) {
                    for (const child of node.shadowRoot.children) traverse(child);
                }
                for (const child of node.children) traverse(child);
            }

            traverse(root);

            const results = [];
            for (const el of nodes) {
                const res = await enrichElement(el);
                if (res) results.push(res);
            }
            return results;
        }

        return { enrichElement, enrichAll };
    })();

    // ========================================================================
    // 6. NETWORK ENGINE: Giữ nguyên Stream gốc bit-for-bit (Phục vụ In Ấn)
    // ========================================================================
    const Network = (() => {
        function downloadBlob(url) {
            return new Promise((resolve, reject) => {
                if (typeof GM_xmlhttpRequest !== 'undefined') {
                    GM_xmlhttpRequest({
                        method: 'GET',
                        url: url.trim(),
                        responseType: 'blob',
                        headers: {
                            'Referer': location.href,
                            'Origin': location.origin,
                            'Accept': 'image/*,*/*'
                        },
                        onload: (res) => {
                            if (res.status >= 200 && res.status < 400 && res.response) {
                                resolve(res.response);
                            } else {
                                reject(new Error(`GM_xhr status: ${res.status}`));
                            }
                        },
                        onerror: reject,
                        ontimeout: reject
                    });
                } else {
                    fetch(url, { mode: 'cors' })
                        .then((res) => {
                            if (!res.ok) throw new Error(`Fetch status: ${res.status}`);
                            return res.blob();
                        })
                        .then(resolve)
                        .catch(reject);
                }
            });
        }

        return { downloadBlob };
    })();

    // ========================================================================
    // 7. AUTO SCROLLER & MUTATION OBSERVER
    // ========================================================================
    const Scroller = (() => {
        function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

        async function run(options = {}) {
            const { step = 500, delay = 120, maxLoops = 250, onStep = null } = options;
            const getHeight = () => Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);

            let currentPos = window.scrollY || window.pageYOffset;
            let lastHeight = 0;
            let loop = 0;

            while (loop++ < maxLoops) {
                const total = getHeight();
                currentPos += step;
                window.scrollTo({ top: currentPos, behavior: 'smooth' });

                await sleep(delay);
                if (typeof onStep === 'function') onStep(currentPos, total);

                if (currentPos + window.innerHeight >= total) {
                    if (total === lastHeight) break;
                    lastHeight = total;
                    await sleep(delay * 2);
                }
            }
            window.scrollTo(0, getHeight());
            await sleep(delay);
        }

        return { run };
    })();

    // ========================================================================
    // 8. SAVER ENGINE (API CHÍNH)
    // ========================================================================
    class SaverEngine {
        constructor() {
            this.vault = BlobVault;
            this.converter = Converter;
            this.canvas = CanvasHarvester;
            this.uncloaker = UrlUncloaker;
            this.enricher = DOMEnricher;
            this.scroller = Scroller;
            this.network = Network;
            this._observer = null;
        }

        init() {
            console.log('[Saver.js v3.0] Engine đã kích hoạt.');
            return this;
        }

        /**
         * Bật chế độ tự động theo dõi DOM: Trang web cứ nạp ảnh mới là tự động
         * gỡ link và bơm trực tiếp `data-saver-src` vào DOM.
         */
        startObserver(targetNode = document.body) {
            if (this._observer) return;
            this._observer = new MutationObserver((mutations) => {
                for (const m of mutations) {
                    for (const node of m.addedNodes) {
                        if (node.nodeType === 1) {
                            this.enricher.enrichElement(node);
                            // Quét các node con mới thêm
                            const imgs = node.querySelectorAll ? node.querySelectorAll('img, canvas') : [];
                            imgs.forEach(img => this.enricher.enrichElement(img));
                        }
                    }
                }
            });
            this._observer.observe(targetNode, { childList: true, subtree: true });
            console.log('[Saver.js] MutationObserver đã chạy: DOM sẽ luôn được tự động bơm link.');
        }

        stopObserver() {
            if (this._observer) {
                this._observer.disconnect();
                this._observer = null;
            }
        }

        /**
         * Bơm thuộc tính link gốc và Blob URL vào toàn bộ phần tử trên trang
         */
        async enrichDOM(root = document.body) {
            return await this.enricher.enrichAll(root);
        }

        /**
         * Giải quyết bất kỳ phần tử hoặc đường dẫn nào thành Blob nguyên gốc (Quality 1.0)
         */
        async toBlob(target) {
            if (!target) return null;

            // Đảm bảo target được enrich nếu là element
            if (target.nodeType === 1 && !target.dataset.saverReady) {
                await this.enricher.enrichElement(target);
            }

            // Nếu phần tử đã có sẵn Blob trong thuộc tính
            if (target._saver && target._saver.blob instanceof Blob) {
                return target._saver.blob;
            }

            // Trích xuất từ Canvas
            if (target instanceof HTMLCanvasElement || (target.tagName && target.tagName.toUpperCase() === 'CANVAS')) {
                const cRes = await this.canvas.toBlob(target, 1.0);
                if (cRes instanceof Blob) return cRes;
                if (typeof cRes === 'string') target = cRes;
            }

            let url = typeof target === 'string' ? target : (target.dataset ? target.dataset.saverSrc : null);
            if (!url && target.src) url = target.src;
            if (!url) return null;

            // Kiểm tra Vault
            if (this.vault.has(url)) return this.vault.get(url);

            // Kiểm tra Base64
            if (url.startsWith('data:')) {
                return this.converter.base64ToBlob(url);
            }

            // Tải bằng Network (giữ nguyên stream bit-for-bit cho in ấn)
            try {
                let blob = await this.network.downloadBlob(url);
                // Xác minh chuẩn định dạng bằng Magic Bytes
                const meta = await this.converter.inspectBlob(blob);
                if (meta && meta.mime !== blob.type) {
                    blob = new Blob([blob], { type: meta.mime });
                }
                return blob;
            } catch (e) {
                console.error('[Saver.js] Tải file thất bại:', url, e);
                return null;
            }
        }

        /**
         * Tải toàn bộ trang: Cuộn trang -> Bơm DOM -> Tải kiểm soát luồng chống tràn RAM
         */
        async harvestAll(options = {}) {
            const { scrollerOpts = {}, concurrency = 3, onProgress = null } = options;

            if (options.autoScroll !== false) {
                await this.scroller.run(scrollerOpts);
            }

            // 1. Quét và bơm toàn bộ link vào DOM
            const enrichedItems = await this.enrichDOM();

            // 2. Chạy hàng đợi tải Blob
            const results = new Array(enrichedItems.length);
            let cursor = 0;

            const worker = async () => {
                while (cursor < enrichedItems.length) {
                    const idx = cursor++;
                    const item = enrichedItems[idx];
                    try {
                        const blob = await this.toBlob(item.element);
                        const meta = blob ? await this.converter.inspectBlob(blob) : null;
                        results[idx] = { success: !!blob, blob, meta, item, index: idx };
                    } catch (err) {
                        results[idx] = { success: false, error: err, item, index: idx };
                    }

                    if (typeof onProgress === 'function') {
                        onProgress(results[idx], idx + 1, enrichedItems.length);
                    }
                }
            };

            const pool = Array(Math.min(concurrency, enrichedItems.length)).fill(0).map(() => worker());
            await Promise.all(pool);
            return results;
        }

        /**
         * Lưu trực tiếp Blob xuống máy tính
         */
        saveBlob(blob, filename = 'image') {
            if (!blob) return;
            const ext = this.converter.MIME_MAP[blob.type] || 'jpg';
            const finalName = filename.endsWith(`.${ext}`) ? filename : `${filename}.${ext}`;

            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = finalName;
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            setTimeout(() => {
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            }, 30000);
        }
    }

    return new SaverEngine().init();
});