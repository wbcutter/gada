#!/usr/bin/env python3
"""
Google Drive PDF/Image Downloader - GUI App v2.0
"""

import os
import re
import sys
import json
import time
import random
import string
import threading
import tkinter as tk
from tkinter import ttk, filedialog, messagebox, scrolledtext
from pathlib import Path
from urllib.parse import urlparse, parse_qs, unquote, quote
from concurrent.futures import ThreadPoolExecutor, as_completed
from io import BytesIO
from typing import Optional

import requests

try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

# ============================================================
# CONSTANTS
# ============================================================
APP_VERSION = "2.0.0"
CONFIG_FILE = "gdrive_config.json"
HEADERS_FILE = "headers.json"

DEFAULT_WIDTH = 2000
MIN_WIDTH = 1000
MAX_WIDTH = 3200
CONCURRENT_DOWNLOADS = 4
PRESET_SIZES = [1000, 1600, 1748, 2000, 2400, 2480, 3200]

DRIVE_REFERER = "https://drive.google.com/"

DEFAULT_HEADERS = {
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "accept-language": "vi,en;q=0.9,en-GB;q=0.8,en-US;q=0.7",
    "cache-control": "max-age=0",
    "Referer": DRIVE_REFERER,
    "cookie": ""
}

DEFAULT_CONFIG = {
    "output_dir": "",          # rỗng = cùng cấp với file .py
    "default_width": DEFAULT_WIDTH,
    "format": "jpg",
    "concurrent": CONCURRENT_DOWNLOADS,
    "saved_sizes": PRESET_SIZES.copy(),
    "last_prefix": "page",
    "pdf_quality": 96,
    "folder_counter": 0,       # đếm folder tự tăng
    "folder_history": {},      # id_short -> folder_name
}


# ============================================================
# HELPERS
# ============================================================
def get_script_dir() -> str:
    return os.path.dirname(os.path.abspath(sys.argv[0]))


def generate_session_id() -> str:
    chars = string.ascii_letters + string.digits
    ts = hex(int(time.time()))[-2:]
    return ts + "".join(random.choices(chars, k=3))


def is_drive_url(text: str) -> bool:
    """Chỉ chấp nhận URL từ drive.google.com"""
    text = text.strip()
    # Loại bỏ scheme để kiểm tra
    cleaned = re.sub(r'^https?://', '', text)
    return cleaned.startswith('drive.google.com')


def normalize_url(text: str) -> str:
    """Thêm https:// nếu thiếu"""
    text = text.strip()
    if not text.startswith('http'):
        text = 'https://' + text
    return text


def short_id_from_full(doc_id: str) -> str:
    """Lấy đoạn đầu ID trước dấu _ đầu tiên (hoặc 14 ký tự)"""
    part = doc_id.split('_')[0] if '_' in doc_id else doc_id
    return part[:14]


def format_page_range(pf: int, pt: int, total: int) -> str:
    d = 4 if total >= 1000 else 3 if total >= 100 else 2 if total >= 10 else 1
    if d == 1:
        return f"p{pf}~p{pt}"
    return f"p{str(pf).zfill(d)}~p{str(pt).zfill(d)}"


# ============================================================
# HEADER PARSER  (JSON fetch / Firefox raw)
# ============================================================
def parse_header_input(raw: str) -> dict:
    """
    Chấp nhận:
    1. JSON thuần  {"cookie": "...", ...}
    2. Chrome "Copy as fetch":
       fetch("URL", { "headers": { ... }, ... })
    3. Firefox raw HTTP:
       GET /path HTTP/3\nHost: ...\nCookie: ...
    Luôn override Referer = DRIVE_REFERER
    """
    raw = raw.strip()
    result = {}

    # ── Thử JSON thuần ──────────────────────────────────────
    if raw.startswith('{'):
        try:
            data = json.loads(raw)
            result = {k.lower(): v for k, v in data.items()}
            result['Referer'] = DRIVE_REFERER
            return result
        except json.JSONDecodeError:
            pass

    # ── Thử Chrome fetch(...) ────────────────────────────────
    fetch_m = re.search(r'fetch\s*\([^,]+,\s*(\{.*\})\s*\)\s*;?\s*$',
                        raw, re.DOTALL)
    if fetch_m:
        try:
            obj = json.loads(fetch_m.group(1))
            headers_raw = obj.get('headers', {})
            result = {k.lower(): v for k, v in headers_raw.items()}
            result['Referer'] = DRIVE_REFERER
            return result
        except json.JSONDecodeError:
            pass

    # ── Thử Firefox raw HTTP ─────────────────────────────────
    lines = raw.splitlines()
    # Bỏ dòng đầu tiên nếu là "GET /path HTTP/x"
    start = 0
    if lines and re.match(r'^(GET|POST|PUT|DELETE|HEAD)\s', lines[0]):
        start = 1

    for line in lines[start:]:
        if ':' in line:
            key, _, val = line.partition(':')
            key = key.strip().lower()
            val = val.strip()
            if key and val:
                result[key] = val

    if result:
        result['Referer'] = DRIVE_REFERER
        return result

    return {}


# ============================================================
# CONFIG MANAGER
# ============================================================
class ConfigManager:
    def __init__(self):
        self.config = DEFAULT_CONFIG.copy()
        self.headers = DEFAULT_HEADERS.copy()
        self.load()

    def load(self):
        if os.path.exists(CONFIG_FILE):
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    saved = json.load(f)
                self.config.update(saved)
            except Exception:
                pass

        if os.path.exists(HEADERS_FILE):
            try:
                with open(HEADERS_FILE, 'r', encoding='utf-8') as f:
                    self.headers = json.load(f)
            except Exception:
                pass
        else:
            self.save_headers()

    def save(self):
        try:
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.config, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Cannot save config: {e}")

    def save_headers(self):
        try:
            with open(HEADERS_FILE, 'w', encoding='utf-8') as f:
                json.dump(self.headers, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"Cannot save headers: {e}")

    def get_session(self) -> requests.Session:
        session = requests.Session()

        # Build request headers (bỏ cookie, set Referer cố định)
        req_headers = {}
        for k, v in self.headers.items():
            kl = k.lower()
            if kl in ('cookie', 'host', 'content-length'):
                continue
            req_headers[k] = v
        req_headers['Referer'] = DRIVE_REFERER
        session.headers.update(req_headers)

        # Parse cookie
        cookie_str = self.headers.get('cookie', '')
        if not cookie_str:
            # Thử key 'Cookie' (firefox raw)
            cookie_str = self.headers.get('Cookie', '')
        if cookie_str:
            for part in cookie_str.split(';'):
                part = part.strip()
                if '=' in part:
                    k, v = part.split('=', 1)
                    session.cookies.set(k.strip(), v.strip(),
                                        domain='.google.com')
        return session

    # ── Folder counter ───────────────────────────────────────
    def next_folder(self, doc_id: str, display_name: str) -> str:
        """
        Trả về tên folder dạng "001 ACFrOgBj97N44W5"
        Ghi nhớ theo doc_id để không tạo mới khi dán lại cùng link.
        """
        short = short_id_from_full(doc_id)
        history: dict = self.config.get('folder_history', {})

        if short in history:
            return history[short]

        counter = self.config.get('folder_counter', 0) + 1
        self.config['folder_counter'] = counter

        folder_name = f"{counter:03d} {display_name}"
        history[short] = folder_name
        self.config['folder_history'] = history
        self.save()
        return folder_name

    def get_output_root(self) -> str:
        d = self.config.get('output_dir', '').strip()
        return d if d else get_script_dir()


# ============================================================
# CORE – extract ID
# ============================================================
def extract_id_from_url(url: str) -> tuple:
    """
    Trả về (doc_id, authuser, dsmi, display_name)
    display_name dùng cho tên folder
    """
    doc_id = ''
    authuser = '0'
    dsmi = 'texmex'
    display_name = ''

    try:
        parsed = urlparse(url)
        qs = parse_qs(parsed.query)

        def qget(k, d=''):
            v = qs.get(k, [None])[0]
            return v if v is not None else d

        if 'id=' in url or 'id' in qs:
            doc_id = qget('id')
            authuser = qget('authuser', '0')
            dsmi = qget('dsmi', 'texmex')
            display_name = short_id_from_full(doc_id)

        elif 'ds=' in url or 'ds' in qs:
            doc_id = qget('ds')
            authuser = qget('authuser', '0')
            dsmi = qget('dsmi', 'texmex')
            display_name = short_id_from_full(doc_id)

    except Exception as e:
        print(f'extract_id error: {e}')

    return doc_id, authuser, dsmi, display_name


def resolve_file_url(file_url: str, session: requests.Session,
                     log_fn=None) -> tuple:
    """
    Từ https://drive.google.com/file/d/FILE_ID/view
    Trả về (doc_id, authuser, dsmi, display_name)
    display_name = tên file (vd: "1.pdf") hoặc đoạn id ngắn
    """
    def log(msg, tag='info'):
        if log_fn:
            log_fn(msg, tag)
        else:
            print(msg)

    log(f'🌐 Đang tải trang: {file_url}')
    try:
        resp = session.get(file_url, timeout=20, allow_redirects=True)
        resp.raise_for_status()
        html = resp.text
    except Exception as e:
        log(f'❌ Không tải được trang: {e}', 'err')
        return '', '0', 'texmex', ''

    # Lấy tên file từ og:title
    og_title = ''
    m_title = re.search(r'<meta property="og:title" content="([^"]+)"', html)
    if m_title:
        og_title = m_title.group(1).strip()
        log(f'📄 Tên file: {og_title}')

    # Pattern 1: viewer/upload?ds=...
    upload_pattern = r'viewer/upload\?ds(?:\\u003d|=)([^\\&"\s]+)'
    m = re.search(upload_pattern, html)
    if m:
        ds_raw = m.group(1)
        ds_raw = ds_raw.replace('\\u003d', '=').replace('%3D', '=')
        ds_decoded = unquote(ds_raw)
        log('✅ Tìm thấy upload ds= → fetch để lấy id thực')

        upload_url = (f'https://drive.google.com/viewer/upload?'
                      f'ds={quote(ds_decoded)}'
                      f'&ck=drive&dsmi=texmex&p=proj')
        try:
            r2 = session.get(upload_url, timeout=15)
            text = r2.text.strip()
            if text.startswith(")]}'"):
                text = text[4:].strip()
            data = json.loads(text)

            meta_str = data.get('meta', '')
            id_m = re.search(r'id=([^&]+)', meta_str)
            if id_m:
                doc_id = unquote(id_m.group(1))
                au_m = re.search(r'authuser=([^&]+)', meta_str)
                dsmi_m = re.search(r'dsmi=([^&]+)', meta_str)
                authuser = au_m.group(1) if au_m else '0'
                dsmi = dsmi_m.group(1) if dsmi_m else 'texmex'
                display_name = og_title if og_title else short_id_from_full(doc_id)
                log(f'✅ Doc ID: {doc_id[:30]}...', 'ok')
                return doc_id, authuser, dsmi, display_name
        except Exception as e:
            log(f'⚠️  Không parse được upload response: {e}', 'warn')

    # Pattern 2: tìm id= trực tiếp
    patterns = [
        r'"meta\?id=([^&"\\]+)',
        r'"img\?id=([^&"\\]+)',
        r'id=([A-Za-z0-9_\-]{40,})',
    ]
    for pat in patterns:
        m = re.search(pat, html)
        if m:
            raw = m.group(1).replace('\\u003d', '=').replace('%3D', '=')
            doc_id = unquote(raw)
            au_m = re.search(r'authuser=([0-9]+)', html)
            authuser = au_m.group(1) if au_m else '0'
            display_name = og_title if og_title else short_id_from_full(doc_id)
            log(f'✅ Doc ID (pattern 2): {doc_id[:30]}...', 'ok')
            return doc_id, authuser, 'texmex', display_name

    log('❌ Không tìm được Doc ID từ HTML!', 'err')
    return '', '0', 'texmex', ''


# ============================================================
# META
# ============================================================
def fetch_meta(doc_id: str, authuser: str, dsmi: str,
               session: requests.Session, log_fn=None) -> dict:
    def log(msg, tag='info'):
        if log_fn:
            log_fn(msg, tag)
        else:
            print(msg)

    url = (f'https://drive.google.com/viewer/meta'
           f'?id={quote(doc_id)}'
           f'&authuser={authuser}'
           f'&dsmi={dsmi}'
           f'&skipbookmarks=false')
    log(f'📡 Fetch meta: {url[:80]}...')
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
        text = resp.text.strip()
        if text.startswith(")]}'"):
            text = text[4:].strip()
        data = json.loads(text)
        pages = data.get('pages', 0)
        max_w = data.get('maxPageWidth', MAX_WIDTH)
        log(f'📖 Tổng trang: {pages} | Max width: {max_w}px')
        return {'pages': pages, 'max_width': max_w}
    except Exception as e:
        log(f'❌ Fetch meta thất bại: {e}', 'err')
        return {'pages': 0, 'max_width': MAX_WIDTH}


# ============================================================
# IMAGE DOWNLOAD
# ============================================================
def build_img_url(doc_id: str, authuser: str, dsmi: str,
                  page_0: int, width: int, webp: bool = False) -> str:
    url = (f'https://drive.google.com/viewer/img'
           f'?id={quote(doc_id)}'
           f'&authuser={authuser}'
           f'&dsmi={dsmi}'
           f'&page={page_0}'
           f'&skiphighlight=true'
           f'&w={width}')
    if webp:
        url += '&webp=true'
    return url


def download_page(doc_id, authuser, dsmi, page_1idx,
                  width, session, fmt='jpg', for_pdf=False) -> dict:
    page_0 = page_1idx - 1
    webp = (fmt == 'webp' or for_pdf)
    url = build_img_url(doc_id, authuser, dsmi, page_0, width, webp)

    try:
        resp = session.get(url, timeout=30, stream=True)
        resp.raise_for_status()
        data = resp.content
        if not data:
            raise ValueError('Empty response')

        if not for_pdf and PIL_AVAILABLE:
            if fmt == 'jpg':
                img = Image.open(BytesIO(data)).convert('RGB')
                buf = BytesIO()
                img.save(buf, format='JPEG', quality=95)
                data = buf.getvalue()
            elif fmt == 'png':
                img = Image.open(BytesIO(data))
                buf = BytesIO()
                img.save(buf, format='PNG')
                data = buf.getvalue()

        return {'success': True, 'page': page_1idx, 'data': data}
    except requests.HTTPError as e:
        code = e.response.status_code if e.response else 0
        return {'success': False, 'page': page_1idx,
                'error': f'HTTP {code}',
                'access_denied': code in (403, 410)}
    except Exception as e:
        return {'success': False, 'page': page_1idx, 'error': str(e)}


# ============================================================
# DOWNLOAD ENGINE
# ============================================================
class DownloadEngine:
    def __init__(self, cfg, log_fn, progress_fn, status_fn, done_fn):
        self.cfg = cfg
        self.log = log_fn
        self.progress = progress_fn
        self.set_status = status_fn
        self.on_done = done_fn
        self.stop_flag = threading.Event()

    def stop(self):
        self.stop_flag.set()

    def run(self, doc_id, authuser, dsmi, page_from, page_to,
            total_pages, width, fmt, output_dir,
            prefix, session_id, as_pdf):
        self.stop_flag.clear()
        t = threading.Thread(
            target=self._run,
            args=(doc_id, authuser, dsmi, page_from, page_to,
                  total_pages, width, fmt, output_dir,
                  prefix, session_id, as_pdf),
            daemon=True)
        t.start()

    def _run(self, doc_id, authuser, dsmi, page_from, page_to,
             total_pages, width, fmt, output_dir,
             prefix, session_id, as_pdf):
        os.makedirs(output_dir, exist_ok=True)
        session = self.cfg.get_session()
        pages = list(range(page_from, page_to + 1))
        total = len(pages)

        self.log(f'🚀 Bắt đầu: {total} trang | W={width} | '
                 f"{'PDF' if as_pdf else fmt.upper()} | {session_id}", 'info')
        t0 = time.time()

        if as_pdf:
            result = self._as_pdf(doc_id, authuser, dsmi, pages, total,
                                  width, output_dir, prefix, session_id,
                                  page_from, page_to, total_pages, session)
        else:
            result = self._as_images(doc_id, authuser, dsmi, pages, total,
                                     width, fmt, output_dir, prefix,
                                     session_id, session)
        result['elapsed'] = time.time() - t0
        self.on_done(result)

    # ── Images ──────────────────────────────────────────────
    def _as_images(self, doc_id, authuser, dsmi, pages, total,
                   width, fmt, output_dir, prefix, session_id, session):
        ok = 0
        err = 0
        concurrent = self.cfg.config.get('concurrent', CONCURRENT_DOWNLOADS)

        with ThreadPoolExecutor(max_workers=concurrent) as ex:
            fmap = {
                ex.submit(download_page, doc_id, authuser, dsmi,
                          pg, width, session, fmt, False): pg
                for pg in pages
            }
            for future in as_completed(fmap):
                if self.stop_flag.is_set():
                    break
                pg = fmap[future]
                res = future.result()
                done = ok + err + 1
                if res['success']:
                    ext = fmt
                    fname = f'{prefix}_{session_id}_{str(pg).zfill(4)}.{ext}'
                    fpath = os.path.join(output_dir, fname)
                    try:
                        with open(fpath, 'wb') as fp:
                            fp.write(res['data'])
                        ok += 1
                        self.log(f'✅ Trang {pg} → {fname}', 'ok')
                    except Exception as e:
                        err += 1
                        self.log(f'❌ Trang {pg} lưu lỗi: {e}', 'err')
                else:
                    err += 1
                    self.log(f'❌ Trang {pg}: {res["error"]}', 'err')
                    if res.get('access_denied'):
                        self.log('🚫 403/410 – Kiểm tra cookie!', 'err')
                self.progress(done, total, ok, err)
                self.set_status(f'Đang tải {done}/{total} | ✓{ok} ✗{err}')

        return {'type': 'images', 'success': ok, 'errors': err,
                'total': total, 'output_dir': output_dir,
                'stopped': self.stop_flag.is_set()}

    # ── PDF ─────────────────────────────────────────────────
    def _as_pdf(self, doc_id, authuser, dsmi, pages, total,
                width, output_dir, prefix, session_id,
                page_from, page_to, total_pages, session):
        if not PIL_AVAILABLE:
            self.log('❌ Cần Pillow: pip install pillow', 'err')
            return {'type': 'pdf', 'success': 0, 'errors': total}

        images = {}
        ok = 0
        err = 0
        concurrent = self.cfg.config.get('concurrent', CONCURRENT_DOWNLOADS)
        quality = self.cfg.config.get('pdf_quality', 96)

        self.set_status('Đang tải ảnh cho PDF...')
        with ThreadPoolExecutor(max_workers=concurrent) as ex:
            fmap = {
                ex.submit(download_page, doc_id, authuser, dsmi,
                          pg, width, session, 'webp', True): pg
                for pg in pages
            }
            for future in as_completed(fmap):
                if self.stop_flag.is_set():
                    break
                pg = fmap[future]
                res = future.result()
                done = ok + err + 1
                if res['success']:
                    images[pg] = res['data']
                    ok += 1
                    self.log(f'✅ Trang {pg}', 'ok')
                else:
                    err += 1
                    self.log(f'❌ Trang {pg}: {res["error"]}', 'err')
                self.progress(done, total, ok, err)
                self.set_status(f'Tải ảnh {done}/{total} | ✓{ok} ✗{err}')

        if not images:
            self.log('❌ Không tải được ảnh nào!', 'err')
            return {'type': 'pdf', 'success': 0, 'errors': err}

        self.set_status('Đang tạo PDF...')
        self.log(f'📄 Ghép {len(images)} ảnh thành PDF (quality={quality}%)...', 'info')

        is_full = (page_from == 1 and page_to == total_pages)
        if is_full:
            pdf_name = f'{prefix}_{session_id}_full.pdf'
        else:
            rng = format_page_range(page_from, page_to, total_pages)
            pdf_name = f'{prefix}_{session_id}_{rng}.pdf'

        pdf_path = os.path.join(output_dir, pdf_name)
        try:
            pil_imgs = []
            for i, pg in enumerate(sorted(images.keys())):
                self.set_status(f'Xử lý trang {i+1}/{len(images)}...')
                img = Image.open(BytesIO(images[pg])).convert('RGB')
                pil_imgs.append(img)

            if pil_imgs:
                pil_imgs[0].save(
                    pdf_path,
                    save_all=True,
                    append_images=pil_imgs[1:],
                    format='PDF',
                    quality=quality
                )
            self.log(f'✅ PDF: {pdf_path}', 'ok')
            return {'type': 'pdf', 'success': len(pil_imgs),
                    'errors': err, 'filepath': pdf_path,
                    'output_dir': output_dir}
        except Exception as e:
            self.log(f'❌ Tạo PDF lỗi: {e}', 'err')
            return {'type': 'pdf', 'success': 0, 'errors': err,
                    'error': str(e)}


# ============================================================
# GUI
# ============================================================
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title(f'GDrive Downloader v{APP_VERSION}')
        self.geometry('800x720')
        self.resizable(True, True)
        self.configure(bg='#f0f0f0')

        self.cfg = ConfigManager()
        self.engine: Optional[DownloadEngine] = None
        self.downloading = False

        self.doc_id = ''
        self.authuser = '0'
        self.dsmi = 'texmex'
        self.display_name = ''
        self.total_pages = 0
        self.max_width = MAX_WIDTH
        self.session_id = generate_session_id()
        self.current_output_dir = ''

        self._build_ui()
        self._load_ui_state()

        self._last_clip = ''
        self._poll_clipboard()

    # ----------------------------------------------------------
    # BUILD UI
    # ----------------------------------------------------------
    def _build_ui(self):
        nb = ttk.Notebook(self)
        nb.pack(fill=tk.BOTH, expand=True, padx=8, pady=8)

        self.tab_main = ttk.Frame(nb)
        self.tab_headers = ttk.Frame(nb)
        self.tab_settings = ttk.Frame(nb)

        nb.add(self.tab_main, text='  📥 Tải xuống  ')
        nb.add(self.tab_headers, text='  🔑 Headers / Cookie  ')
        nb.add(self.tab_settings, text='  ⚙️ Cài đặt  ')

        self._build_main_tab()
        self._build_headers_tab()
        self._build_settings_tab()

        self.status_var = tk.StringVar(value='Sẵn sàng')
        tk.Label(self, textvariable=self.status_var,
                 relief=tk.SUNKEN, anchor=tk.W,
                 bg='#e0e0e0', font=('Arial', 9)
                 ).pack(side=tk.BOTTOM, fill=tk.X)

    # ── Main tab ────────────────────────────────────────────
    def _build_main_tab(self):
        f = self.tab_main
        P = {'padx': 8, 'pady': 4}

        # URL
        uf = ttk.LabelFrame(f, text='🔗 URL (drive.google.com)')
        uf.pack(fill=tk.X, **P)

        self.url_var = tk.StringVar()
        ttk.Entry(uf, textvariable=self.url_var,
                  font=('Consolas', 9)
                  ).pack(side=tk.LEFT, fill=tk.X, expand=True, padx=6, pady=6)
        ttk.Button(uf, text='📋 Dán',
                   command=self._paste_url).pack(side=tk.LEFT, padx=2)
        ttk.Button(uf, text='🔍 Phân tích',
                   command=self._analyze_url).pack(side=tk.LEFT, padx=2)

        # Info
        inf = ttk.LabelFrame(f, text='📋 Thông tin tài liệu')
        inf.pack(fill=tk.X, **P)
        self.info_var = tk.StringVar(value='Chưa phân tích URL')
        ttk.Label(inf, textvariable=self.info_var,
                  foreground='#1565C0',
                  font=('Arial', 9)).pack(anchor=tk.W, padx=6, pady=4)

        self.folder_var = tk.StringVar(value='')
        ttk.Label(inf, textvariable=self.folder_var,
                  foreground='#6a1b9a',
                  font=('Arial', 9)).pack(anchor=tk.W, padx=6, pady=(0, 4))

        # Options
        opt = ttk.LabelFrame(f, text='⚙️ Tùy chọn')
        opt.pack(fill=tk.X, **P)

        # Row1: prefix + output
        r1 = ttk.Frame(opt)
        r1.pack(fill=tk.X, padx=6, pady=4)
        ttk.Label(r1, text='Prefix file:').pack(side=tk.LEFT)
        self.prefix_var = tk.StringVar(
            value=self.cfg.config.get('last_prefix', 'page'))
        ttk.Entry(r1, textvariable=self.prefix_var,
                  width=10).pack(side=tk.LEFT, padx=4)
        ttk.Label(r1, text='  Thư mục:').pack(side=tk.LEFT)
        self.outdir_var = tk.StringVar(value='(cùng cấp file .py)')
        ttk.Entry(r1, textvariable=self.outdir_var,
                  width=24, state='readonly').pack(side=tk.LEFT, padx=2)
        ttk.Button(r1, text='📁 Đổi',
                   command=self._browse_dir).pack(side=tk.LEFT)
        ttk.Button(r1, text='↩ Mặc định',
                   command=self._reset_dir).pack(side=tk.LEFT, padx=2)

        # Row2: size presets
        r2 = ttk.Frame(opt)
        r2.pack(fill=tk.X, padx=6, pady=4)
        ttk.Label(r2, text='Kích thước (px):').pack(side=tk.LEFT)
        self.width_var = tk.IntVar(
            value=self.cfg.config.get('default_width', DEFAULT_WIDTH))
        for sz in self.cfg.config.get('saved_sizes', PRESET_SIZES):
            ttk.Button(r2, text=str(sz), width=5,
                       command=lambda s=sz: self.width_var.set(s)
                       ).pack(side=tk.LEFT, padx=1)
        ttk.Label(r2, text=' Tùy:').pack(side=tk.LEFT)
        ttk.Spinbox(r2, from_=MIN_WIDTH, to=MAX_WIDTH,
                    textvariable=self.width_var,
                    width=6, increment=100).pack(side=tk.LEFT)

        # Row3: format + pdf toggle
        r3 = ttk.Frame(opt)
        r3.pack(fill=tk.X, padx=6, pady=4)
        ttk.Label(r3, text='Định dạng:').pack(side=tk.LEFT)
        self.fmt_var = tk.StringVar(
            value=self.cfg.config.get('format', 'jpg'))
        ttk.Combobox(r3, textvariable=self.fmt_var,
                     values=['jpg', 'png', 'webp'],
                     state='readonly', width=6).pack(side=tk.LEFT, padx=4)

        self.as_pdf_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(r3, text='📄 Xuất PDF',
                        variable=self.as_pdf_var).pack(side=tk.LEFT, padx=8)

        # Row4: pages
        r4 = ttk.Frame(opt)
        r4.pack(fill=tk.X, padx=6, pady=4)
        ttk.Label(r4, text='Trang từ:').pack(side=tk.LEFT)
        self.page_from_var = tk.IntVar(value=1)
        ttk.Spinbox(r4, from_=1, to=9999,
                    textvariable=self.page_from_var,
                    width=6).pack(side=tk.LEFT, padx=2)
        ttk.Label(r4, text=' đến:').pack(side=tk.LEFT)
        self.page_to_var = tk.IntVar(value=1)
        ttk.Spinbox(r4, from_=1, to=9999,
                    textvariable=self.page_to_var,
                    width=6).pack(side=tk.LEFT, padx=2)
        self.pages_label = ttk.Label(r4, text='(chưa biết tổng trang)',
                                     foreground='#888')
        self.pages_label.pack(side=tk.LEFT, padx=8)
        ttk.Button(r4, text='🔍 Lấy số trang',
                   command=self._fetch_meta).pack(side=tk.LEFT)

        # Buttons
        bf = ttk.Frame(f)
        bf.pack(fill=tk.X, padx=8, pady=6)
        self.dl_btn = ttk.Button(
            bf, text='⬇️  Tải trang đã chọn',
            command=lambda: self._start_download(False))
        self.dl_btn.pack(side=tk.LEFT, padx=4, ipady=4, ipadx=8)

        self.dl_all_btn = ttk.Button(
            bf, text='📥 Tải TẤT CẢ',
            command=lambda: self._start_download(True))
        self.dl_all_btn.pack(side=tk.LEFT, padx=4, ipady=4, ipadx=8)

        self.stop_btn = ttk.Button(
            bf, text='⏹ Dừng',
            command=self._stop_download, state=tk.DISABLED)
        self.stop_btn.pack(side=tk.LEFT, padx=4, ipady=4, ipadx=8)

        ttk.Button(bf, text='🗑 Xóa log',
                   command=self._clear_log).pack(side=tk.RIGHT, padx=4)

        # Progress
        pf = ttk.Frame(f)
        pf.pack(fill=tk.X, padx=8)
        self.progress_var = tk.DoubleVar(value=0)
        ttk.Progressbar(pf, variable=self.progress_var,
                        maximum=100).pack(fill=tk.X, pady=4)
        self.prog_label = ttk.Label(pf, text='', font=('Arial', 9))
        self.prog_label.pack(anchor=tk.W)

        # Log
        lf = ttk.LabelFrame(f, text='📋 Log')
        lf.pack(fill=tk.BOTH, expand=True, padx=8, pady=4)
        self.log_box = scrolledtext.ScrolledText(
            lf, height=10, font=('Consolas', 8),
            state=tk.DISABLED, bg='#1e1e1e', fg='#d4d4d4')
        self.log_box.pack(fill=tk.BOTH, expand=True, padx=4, pady=4)
        self.log_box.tag_config('ok', foreground='#4ec9b0')
        self.log_box.tag_config('err', foreground='#f44747')
        self.log_box.tag_config('info', foreground='#9cdcfe')
        self.log_box.tag_config('warn', foreground='#dcdcaa')

    # ── Headers tab ─────────────────────────────────────────
    def _build_headers_tab(self):
        f = self.tab_headers
        P = {'padx': 8, 'pady': 4}

        ttk.Label(
            f,
            text=(
                '📌 Hỗ trợ 3 định dạng:\n'
                '  1. JSON thuần: {"cookie": "...", ...}\n'
                '  2. Chrome "Copy as fetch": fetch("URL", {"headers": {...}})\n'
                '  3. Firefox Raw HTTP headers (dán thẳng từ DevTools)\n'
                'Referer sẽ luôn được ghi đè thành https://drive.google.com/'
            ),
            foreground='#555', justify=tk.LEFT
        ).pack(anchor=tk.W, **P)

        self.headers_text = scrolledtext.ScrolledText(
            f, height=16, font=('Consolas', 8), wrap=tk.NONE)
        self.headers_text.pack(fill=tk.BOTH, expand=True, **P)
        self.headers_text.insert(
            tk.END,
            json.dumps(self.cfg.headers, indent=2, ensure_ascii=False))

        bf = ttk.Frame(f)
        bf.pack(fill=tk.X, **P)
        ttk.Button(bf, text='✅ Áp dụng headers',
                   command=self._apply_headers).pack(side=tk.LEFT, padx=4)
        ttk.Button(bf, text='🔄 Reset mặc định',
                   command=self._reset_headers).pack(side=tk.LEFT, padx=4)

        ttk.Separator(f).pack(fill=tk.X, padx=8, pady=4)
        ttk.Label(f, text='🍪 Paste nhanh cookie string:',
                  font=('Arial', 9, 'bold')).pack(anchor=tk.W, padx=8)
        self.cookie_var = tk.StringVar()
        ttk.Entry(f, textvariable=self.cookie_var,
                  font=('Consolas', 8)).pack(fill=tk.X, padx=8, pady=4)
        ttk.Button(f, text='✅ Áp dụng cookie',
                   command=self._apply_cookie).pack(padx=8, anchor=tk.W)

        self.header_status = ttk.Label(f, text='', foreground='#2e7d32')
        self.header_status.pack(anchor=tk.W, padx=8, pady=4)

    # ── Settings tab ────────────────────────────────────────
    def _build_settings_tab(self):
        f = self.tab_settings
        P = {'padx': 8, 'pady': 6}

        rows = [
            ('Thư mục mặc định:', 'def_outdir', 'dir'),
            ('Kích thước mặc định (px):', 'def_width', 'spin'),
            ('Định dạng mặc định:', 'def_fmt', 'combo'),
            ('Số luồng song song:', 'def_concurrent', 'spin2'),
            ('Chất lượng PDF (%):', 'def_quality', 'spin3'),
        ]

        r = ttk.Frame(f)
        r.pack(fill=tk.X, **P)
        ttk.Label(r, text='Thư mục mặc định:', width=26).pack(side=tk.LEFT)
        self.def_outdir = tk.StringVar(
            value=self.cfg.config.get('output_dir', ''))
        ttk.Entry(r, textvariable=self.def_outdir).pack(
            side=tk.LEFT, fill=tk.X, expand=True, padx=4)
        ttk.Button(r, text='📁',
                   command=lambda: self.def_outdir.set(
                       filedialog.askdirectory() or self.def_outdir.get())
                   ).pack(side=tk.LEFT)
        ttk.Button(r, text='↩',
                   command=lambda: self.def_outdir.set('')
                   ).pack(side=tk.LEFT)

        r2 = ttk.Frame(f)
        r2.pack(fill=tk.X, **P)
        ttk.Label(r2, text='Kích thước mặc định (px):', width=26).pack(side=tk.LEFT)
        self.def_width = tk.IntVar(
            value=self.cfg.config.get('default_width', DEFAULT_WIDTH))
        ttk.Spinbox(r2, from_=MIN_WIDTH, to=MAX_WIDTH,
                    textvariable=self.def_width,
                    width=8, increment=100).pack(side=tk.LEFT)

        r3 = ttk.Frame(f)
        r3.pack(fill=tk.X, **P)
        ttk.Label(r3, text='Định dạng mặc định:', width=26).pack(side=tk.LEFT)
        self.def_fmt = tk.StringVar(
            value=self.cfg.config.get('format', 'jpg'))
        ttk.Combobox(r3, textvariable=self.def_fmt,
                     values=['jpg', 'png', 'webp'],
                     state='readonly', width=8).pack(side=tk.LEFT)

        r4 = ttk.Frame(f)
        r4.pack(fill=tk.X, **P)
        ttk.Label(r4, text='Số luồng song song:', width=26).pack(side=tk.LEFT)
        self.def_concurrent = tk.IntVar(
            value=self.cfg.config.get('concurrent', CONCURRENT_DOWNLOADS))
        ttk.Spinbox(r4, from_=1, to=16,
                    textvariable=self.def_concurrent,
                    width=5).pack(side=tk.LEFT)

        r5 = ttk.Frame(f)
        r5.pack(fill=tk.X, **P)
        ttk.Label(r5, text='Chất lượng PDF (90-96%):', width=26).pack(side=tk.LEFT)
        self.def_quality = tk.IntVar(
            value=self.cfg.config.get('pdf_quality', 96))
        ttk.Spinbox(r5, from_=90, to=96,
                    textvariable=self.def_quality,
                    width=5).pack(side=tk.LEFT)

        r6 = ttk.LabelFrame(f, text='📐 Preset kích thước (cách nhau bởi dấu phẩy)')
        r6.pack(fill=tk.X, **P)
        self.saved_sizes_var = tk.StringVar(
            value=','.join(str(s) for s in
                           self.cfg.config.get('saved_sizes', PRESET_SIZES)))
        ttk.Entry(r6, textvariable=self.saved_sizes_var
                  ).pack(fill=tk.X, padx=6, pady=4)

        ttk.Button(f, text='💾 Lưu cài đặt',
                   command=self._save_settings).pack(pady=10)

    # ----------------------------------------------------------
    # PASTE / ANALYZE URL
    # ----------------------------------------------------------
    def _paste_url(self):
        try:
            text = self.clipboard_get().strip()
            if not text:
                return
            if not is_drive_url(text):
                self.log_msg('⚠️  Clipboard không chứa link drive.google.com', 'warn')
                return
            self.url_var.set(normalize_url(text))
            self._analyze_url()
        except Exception:
            pass

    def _analyze_url(self):
        raw = self.url_var.get().strip()
        if not raw:
            messagebox.showwarning('Thiếu URL', 'Vui lòng nhập URL!')
            return
        if not is_drive_url(raw):
            messagebox.showwarning('URL không hợp lệ',
                                   'Chỉ chấp nhận link từ drive.google.com!')
            return
        url = normalize_url(raw)
        self.log_msg(f'🔍 Phân tích: {url[:80]}...', 'info')

        # /file/d/ID/view
        if re.match(r'https://drive\.google\.com/file/d/', url):
            self.log_msg('🌐 Link file view → tải HTML...', 'info')
            session = self.cfg.get_session()
            threading.Thread(
                target=self._resolve_thread,
                args=(url, session), daemon=True).start()
            return

        doc_id, authuser, dsmi, display_name = extract_id_from_url(url)
        if not doc_id:
            self.info_var.set('❌ Không tìm được ID!')
            self.log_msg('❌ Không tìm được Doc ID từ URL', 'err')
            return
        self.after(0, lambda: self._set_doc_info(
            doc_id, authuser, dsmi, display_name))

    def _resolve_thread(self, url, session):
        doc_id, authuser, dsmi, display_name = resolve_file_url(
            url, session, log_fn=self.log_msg)
        if doc_id:
            self.after(0, lambda: self._set_doc_info(
                doc_id, authuser, dsmi, display_name))
        else:
            self.after(0, lambda: self.info_var.set(
                '❌ Không tìm được ID từ trang!'))

    def _set_doc_info(self, doc_id, authuser, dsmi, display_name):
        self.doc_id = doc_id
        self.authuser = authuser
        self.dsmi = dsmi
        self.display_name = display_name

        # Tạo/lấy folder
        folder_name = self.cfg.next_folder(doc_id, display_name or short_id_from_full(doc_id))
        root = self.cfg.get_output_root()
        self.current_output_dir = os.path.join(root, folder_name)

        self.info_var.set(
            f'✅ ID: {doc_id[:35]}...  | authuser={authuser} | dsmi={dsmi}')
        self.folder_var.set(f'📁 Folder: {self.current_output_dir}')
        self.outdir_var.set(self.current_output_dir)
        self.log_msg(f'✅ Doc ID: {doc_id[:50]}...', 'ok')
        self.log_msg(f'   Folder: {self.current_output_dir}', 'info')
        self._fetch_meta()

    # ----------------------------------------------------------
    # META
    # ----------------------------------------------------------
    def _fetch_meta(self):
        if not self.doc_id:
            messagebox.showwarning('Chưa có ID', 'Hãy phân tích URL trước!')
            return
        self.set_status('⏳ Đang lấy thông tin trang...')
        session = self.cfg.get_session()
        threading.Thread(
            target=lambda: self._fetch_meta_thread(session),
            daemon=True).start()

    def _fetch_meta_thread(self, session):
        meta = fetch_meta(self.doc_id, self.authuser, self.dsmi,
                          session, log_fn=self.log_msg)
        self.total_pages = meta['pages']
        self.max_width = meta['max_width']
        self.after(0, self._update_meta_ui)

    def _update_meta_ui(self):
        if self.total_pages > 0:
            self.pages_label.config(
                text=f'Tổng: {self.total_pages} | Max: {self.max_width}px',
                foreground='#2e7d32')
            self.page_from_var.set(1)
            self.page_to_var.set(self.total_pages)
            if self.width_var.get() > self.max_width:
                self.width_var.set(self.max_width)
        else:
            self.pages_label.config(
                text='⚠️ Không lấy được số trang',
                foreground='#e65100')
        self.set_status('Sẵn sàng')

    # ----------------------------------------------------------
    # DOWNLOAD
    # ----------------------------------------------------------
    def _start_download(self, all_pages: bool):
        if self.downloading:
            messagebox.showwarning('Đang tải', 'Đang có download chạy!')
            return
        if not self.doc_id:
            messagebox.showerror('Thiếu ID', 'Hãy phân tích URL trước!')
            return

        width = max(MIN_WIDTH, min(MAX_WIDTH, int(self.width_var.get())))
        prefix = self.prefix_var.get().strip() or 'page'
        output_dir = self.current_output_dir or self.outdir_var.get().strip()
        fmt = self.fmt_var.get()
        as_pdf = self.as_pdf_var.get()

        if all_pages:
            if self.total_pages == 0:
                messagebox.showerror('Chưa biết tổng trang',
                                     'Bấm "Lấy số trang" trước!')
                return
            page_from, page_to = 1, self.total_pages
        else:
            page_from = int(self.page_from_var.get())
            page_to = int(self.page_to_var.get())
            if page_from > page_to:
                page_from, page_to = page_to, page_from

        total_pages = self.total_pages if self.total_pages > 0 else page_to
        self.session_id = generate_session_id()

        self.log_msg(
            f"{'='*50}\n"
            f"▶️  {self.session_id} | Trang {page_from}→{page_to} "
            f"| W={width} | {'PDF' if as_pdf else fmt.upper()}\n"
            f"   → {output_dir}", 'info')

        self.cfg.config['last_prefix'] = prefix
        self.cfg.config['default_width'] = width
        self.cfg.config['format'] = fmt
        self.cfg.save()

        self.downloading = True
        self.dl_btn.config(state=tk.DISABLED)
        self.dl_all_btn.config(state=tk.DISABLED)
        self.stop_btn.config(state=tk.NORMAL)
        self.progress_var.set(0)
        self.prog_label.config(text='')

        self.engine = DownloadEngine(
            cfg=self.cfg,
            log_fn=self.log_msg,
            progress_fn=self._update_progress,
            status_fn=self.set_status,
            done_fn=self._on_done)

        self.engine.run(
            doc_id=self.doc_id,
            authuser=self.authuser,
            dsmi=self.dsmi,
            page_from=page_from,
            page_to=page_to,
            total_pages=total_pages,
            width=width,
            fmt=fmt,
            output_dir=output_dir,
            prefix=prefix,
            session_id=self.session_id,
            as_pdf=as_pdf)

    def _stop_download(self):
        if self.engine:
            self.engine.stop()
        self.log_msg('⏹ Yêu cầu dừng...', 'warn')
        self.stop_btn.config(state=tk.DISABLED)

    def _update_progress(self, current, total, success, errors):
        pct = (current / total * 100) if total > 0 else 0
        self.after(0, lambda: [
            self.progress_var.set(pct),
            self.prog_label.config(
                text=f'{current}/{total} | ✓{success}  ✗{errors}')
        ])

    def _on_done(self, result):
        self.downloading = False
        elapsed = result.get('elapsed', 0)

        def _update():
            self.dl_btn.config(state=tk.NORMAL)
            self.dl_all_btn.config(state=tk.NORMAL)
            self.stop_btn.config(state=tk.DISABLED)
            self.progress_var.set(100)

            if result.get('stopped'):
                self.log_msg(
                    f"⏹ Dừng | ✓{result.get('success',0)} "
                    f"✗{result.get('errors',0)} | {elapsed:.1f}s", 'warn')
                self.set_status('Đã dừng')
                return

            if result.get('type') == 'pdf':
                if result.get('success', 0) > 0:
                    self.log_msg(
                        f"✅ PDF: {result.get('filepath','')}\n"
                        f"   {result['success']} trang | {elapsed:.1f}s", 'ok')
                    self.set_status(
                        f"✅ PDF xong! {result['success']} trang | {elapsed:.1f}s")
                    out = result.get('output_dir', '')
                    if out and os.path.exists(out):
                        os.startfile(out)
                else:
                    self.log_msg(
                        f"❌ PDF thất bại: {result.get('error','')}", 'err')
                    self.set_status('❌ Tạo PDF thất bại')
            else:
                ok = result.get('success', 0)
                err = result.get('errors', 0)
                tag = 'ok' if err == 0 else 'warn'
                self.log_msg(
                    f"{'✅' if err==0 else '⚠️'} Xong! "
                    f"✓{ok} ✗{err} | {elapsed:.1f}s", tag)
                self.set_status(
                    f"{'✅' if err==0 else '⚠️'} ✓{ok} ✗{err} | {elapsed:.1f}s")
                out = result.get('output_dir', '')
                if out and os.path.exists(out):
                    os.startfile(out)

        self.after(0, _update)

    # ----------------------------------------------------------
    # HEADERS / COOKIES
    # ----------------------------------------------------------
    def _apply_headers(self):
        raw = self.headers_text.get('1.0', tk.END).strip()
        parsed = parse_header_input(raw)
        if not parsed:
            messagebox.showerror(
                'Lỗi parse',
                'Không đọc được headers!\n\n'
                'Hỗ trợ:\n'
                '  • JSON: {"cookie": "...", ...}\n'
                '  • Chrome fetch(...)\n'
                '  • Firefox raw HTTP headers')
            return
        self.cfg.headers = parsed
        self.cfg.save_headers()
        # Hiển thị lại dạng JSON đẹp
        self.headers_text.delete('1.0', tk.END)
        self.headers_text.insert(
            tk.END,
            json.dumps(parsed, indent=2, ensure_ascii=False))
        self.header_status.config(
            text=f'✅ Đã áp dụng {len(parsed)} headers | Referer = drive.google.com',
            foreground='#2e7d32')
        self.log_msg(f'✅ Headers áp dụng: {len(parsed)} keys', 'ok')

    def _reset_headers(self):
        self.cfg.headers = DEFAULT_HEADERS.copy()
        self.cfg.save_headers()
        self.headers_text.delete('1.0', tk.END)
        self.headers_text.insert(
            tk.END,
            json.dumps(self.cfg.headers, indent=2, ensure_ascii=False))
        self.header_status.config(text='🔄 Reset về mặc định', foreground='#888')

    def _apply_cookie(self):
        cookie = self.cookie_var.get().strip()
        if not cookie:
            return
        self.cfg.headers['cookie'] = cookie
        self.cfg.save_headers()
        self.headers_text.delete('1.0', tk.END)
        self.headers_text.insert(
            tk.END,
            json.dumps(self.cfg.headers, indent=2, ensure_ascii=False))
        self.header_status.config(
            text='🍪 Cookie đã cập nhật!', foreground='#2e7d32')
        self.log_msg('🍪 Cookie đã cập nhật!', 'ok')

    # ----------------------------------------------------------
    # SETTINGS
    # ----------------------------------------------------------
    def _save_settings(self):
        self.cfg.config['output_dir'] = self.def_outdir.get().strip()
        self.cfg.config['default_width'] = int(self.def_width.get())
        self.cfg.config['format'] = self.def_fmt.get()
        self.cfg.config['concurrent'] = int(self.def_concurrent.get())
        self.cfg.config['pdf_quality'] = max(90, min(96, int(self.def_quality.get())))
        try:
            sizes = sorted(set(
                max(MIN_WIDTH, min(MAX_WIDTH, int(s.strip())))
                for s in self.saved_sizes_var.get().split(',')
                if s.strip().isdigit()))
            self.cfg.config['saved_sizes'] = sizes
        except Exception:
            pass
        self.cfg.save()
        messagebox.showinfo('OK', 'Đã lưu cài đặt!\nKhởi động lại để áp dụng preset size.')

    def _load_ui_state(self):
        self.width_var.set(self.cfg.config.get('default_width', DEFAULT_WIDTH))
        self.fmt_var.set(self.cfg.config.get('format', 'jpg'))
        self.prefix_var.set(self.cfg.config.get('last_prefix', 'page'))

    # ----------------------------------------------------------
    # DIR HELPERS
    # ----------------------------------------------------------
    def _browse_dir(self):
        d = filedialog.askdirectory()
        if d:
            self.current_output_dir = d
            self.outdir_var.set(d)

    def _reset_dir(self):
        """Reset về folder tự động theo ID"""
        if self.doc_id:
            folder_name = self.cfg.next_folder(
                self.doc_id,
                self.display_name or short_id_from_full(self.doc_id))
            root = self.cfg.get_output_root()
            self.current_output_dir = os.path.join(root, folder_name)
            self.outdir_var.set(self.current_output_dir)
            self.folder_var.set(f'📁 Folder: {self.current_output_dir}')
        else:
            self.current_output_dir = ''
            self.outdir_var.set('(cùng cấp file .py)')

    # ----------------------------------------------------------
    # LOG / STATUS
    # ----------------------------------------------------------
    def log_msg(self, msg: str, tag: str = ''):
        def _w():
            self.log_box.config(state=tk.NORMAL)
            ts = time.strftime('%H:%M:%S')
            self.log_box.insert(tk.END, f'[{ts}] {msg}\n', tag)
            self.log_box.see(tk.END)
            self.log_box.config(state=tk.DISABLED)
        self.after(0, _w)

    def set_status(self, text: str):
        self.after(0, lambda: self.status_var.set(text))

    def _clear_log(self):
        self.log_box.config(state=tk.NORMAL)
        self.log_box.delete('1.0', tk.END)
        self.log_box.config(state=tk.DISABLED)

    # ----------------------------------------------------------
    # CLIPBOARD MONITOR
    # ----------------------------------------------------------
    def _poll_clipboard(self):
        try:
            clip = self.clipboard_get().strip()
            if clip != self._last_clip:
                self._last_clip = clip
                # Chỉ nhận link drive.google.com
                if is_drive_url(clip):
                    self.url_var.set(normalize_url(clip))
                    self.log_msg('📋 Tự động nhận URL từ clipboard', 'info')
                    self._analyze_url()
        except Exception:
            pass
        self.after(2000, self._poll_clipboard)


# ============================================================
# MAIN
# ============================================================
if __name__ == '__main__':
    if not PIL_AVAILABLE:
        print('⚠️  Pillow chưa cài: pip install pillow')
    app = App()
    app.mainloop()