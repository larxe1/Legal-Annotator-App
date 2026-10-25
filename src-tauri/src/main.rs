#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::{
    codecs::png::{CompressionType, FilterType, PngEncoder},
    ExtendedColorType, ImageEncoder,
};
use libloading::{Library, Symbol};
use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    ffi::{c_char, c_int, c_void, CString},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct RawPdfDoc {
    handle: usize,
    _backing_bytes: Option<PinVec>,
}

struct PinVec(#[allow(dead_code)] Box<[u8]>);

struct PdfiumHolder {
    lib: Option<Library>,
    docs: HashMap<String, RawPdfDoc>,
    page_cache: VecDeque<(String, String)>, // (cache_key, data_url)
}

unsafe impl Send for PdfiumHolder {}

struct AppState {
    pdfium: Mutex<PdfiumHolder>,
    sqlite_path: PathBuf,
    pdf_cache_dir: PathBuf,
    page_vault_dir: PathBuf,
    oauth_path: PathBuf,
    oauth_token: Arc<Mutex<Option<String>>>,
    oauth_status: Arc<Mutex<String>>,
}

#[derive(Serialize)]
struct OAuthPollResponse {
    status: String,
    #[serde(rename = "accessToken")]
    access_token: Option<String>,
}

#[derive(Serialize)]
struct SystemStatus {
    available: bool,
    #[serde(rename = "pdfiumLoaded")]
    pdfium_loaded: bool,
    engine: String,
    #[serde(rename = "sqliteNotes")]
    sqlite_notes: usize,
    #[serde(rename = "sqliteAnnNotes")]
    sqlite_ann_notes: usize,
    #[serde(rename = "cachedPdfs")]
    cached_pdfs: usize,
}

#[derive(Serialize)]
struct OpenPdfResponse {
    ok: bool,
    #[serde(rename = "pageCount")]
    page_count: i32,
}

#[derive(Serialize)]
struct PickedPdfResponse {
    name: String,
    path: String,
    base64: String,
}

const EMBEDDED_PDFIUM_DLL: &[u8] = include_bytes!("../bin/pdfium.dll");

fn resolve_data_dir() -> PathBuf {
    let dev_d_drive = PathBuf::from(r"D:\Code\legal-annotator-desktop\data");
    if dev_d_drive.exists() {
        return dev_d_drive;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let portable_dir = dir.join("LegalAnnotatorData");
            if fs::create_dir_all(&portable_dir).is_ok() {
                return portable_dir;
            }
        }
    }
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let app_dir = PathBuf::from(local_app_data).join("LegalAnnotatorDesktop").join("data");
        let _ = fs::create_dir_all(&app_dir);
        return app_dir;
    }
    let fallback = PathBuf::from("LegalAnnotatorData");
    let _ = fs::create_dir_all(&fallback);
    fallback
}

fn find_pdfium_dll(data_dir: &Path) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("pdfium.dll"));
            candidates.push(dir.join("bin").join("pdfium.dll"));
            if let Some(parent) = dir.parent() {
                if let Some(grand) = parent.parent() {
                    candidates.push(grand.join("bin").join("pdfium.dll"));
                }
            }
        }
    }
    candidates.push(data_dir.join("bin").join("pdfium.dll"));
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join("pdfium.dll"));
        candidates.push(cwd.join("bin").join("pdfium.dll"));
        candidates.push(cwd.join("pdfium.dll"));
    }
    candidates.push(PathBuf::from(r"D:\Code\legal-annotator-desktop\src-tauri\bin\pdfium.dll"));

    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return Some(found);
    }

    // Auto-extract embedded pdfium.dll so the .exe works as a single standalone portable file on any PC/laptop
    let extracted_bin_dir = data_dir.join("bin");
    if fs::create_dir_all(&extracted_bin_dir).is_ok() {
        let dll_target = extracted_bin_dir.join("pdfium.dll");
        if fs::write(&dll_target, EMBEDDED_PDFIUM_DLL).is_ok() {
            return Some(dll_target);
        }
    }
    None
}

impl PdfiumHolder {
    fn new(data_dir: &Path) -> Self {
        let mut lib_opt = None;
        if let Some(dll_path) = find_pdfium_dll(data_dir) {
            unsafe {
                if let Ok(lib) = Library::new(&dll_path) {
                    if let Ok(init_fn) = lib.get::<unsafe extern "C" fn()>(b"FPDF_InitLibrary\0") {
                        init_fn();
                        lib_opt = Some(lib);
                    }
                }
            }
        }
        Self {
            lib: lib_opt,
            docs: HashMap::new(),
            page_cache: VecDeque::new(),
        }
    }

    fn close_doc(&mut self, doc_id: &str) {
        if let Some(old) = self.docs.remove(doc_id) {
            if let Some(ref lib) = self.lib {
                unsafe {
                    if let Ok(close_fn) =
                        lib.get::<unsafe extern "C" fn(*mut c_void)>(b"FPDF_CloseDocument\0")
                    {
                        close_fn(old.handle as *mut c_void);
                    }
                }
            }
        }
    }

    fn open_path(&mut self, doc_id: String, path: &str) -> Result<i32, String> {
        self.close_doc(&doc_id);
        let lib = self.lib.as_ref().ok_or("pdfium.dll not loaded")?;
        let c_path = CString::new(path).map_err(|e| e.to_string())?;
        unsafe {
            let load_doc: Symbol<unsafe extern "C" fn(*const c_char, *const c_char) -> *mut c_void> =
                lib.get(b"FPDF_LoadDocument\0").map_err(|e| e.to_string())?;
            let get_count: Symbol<unsafe extern "C" fn(*mut c_void) -> c_int> =
                lib.get(b"FPDF_GetPageCount\0").map_err(|e| e.to_string())?;
            let handle = load_doc(c_path.as_ptr(), std::ptr::null());
            if handle.is_null() {
                return Err("FPDF_LoadDocument returned null".into());
            }
            let count = get_count(handle);
            self.docs.insert(
                doc_id,
                RawPdfDoc {
                    handle: handle as usize,
                    _backing_bytes: None,
                },
            );
            Ok(count)
        }
    }

    fn open_bytes(&mut self, doc_id: String, bytes: Vec<u8>) -> Result<i32, String> {
        self.close_doc(&doc_id);
        let lib = self.lib.as_ref().ok_or("pdfium.dll not loaded")?;
        let boxed = bytes.into_boxed_slice();
        let ptr = boxed.as_ptr();
        let len = boxed.len() as c_int;
        unsafe {
            let load_mem: Symbol<
                unsafe extern "C" fn(*const u8, c_int, *const c_char) -> *mut c_void,
            > = lib
                .get(b"FPDF_LoadMemDocument\0")
                .map_err(|e| e.to_string())?;
            let get_count: Symbol<unsafe extern "C" fn(*mut c_void) -> c_int> =
                lib.get(b"FPDF_GetPageCount\0").map_err(|e| e.to_string())?;
            let handle = load_mem(ptr, len, std::ptr::null());
            if handle.is_null() {
                return Err("FPDF_LoadMemDocument returned null".into());
            }
            let count = get_count(handle);
            self.docs.insert(
                doc_id,
                RawPdfDoc {
                    handle: handle as usize,
                    _backing_bytes: Some(PinVec(boxed)),
                },
            );
            Ok(count)
        }
    }

    fn render_page_png_data_url(
        &mut self,
        doc_id: &str,
        page_num: u32,
        width_px: u32,
        height_px: u32,
    ) -> Result<String, String> {
        let cache_key = format!("{}:{}:{}x{}", doc_id, page_num, width_px, height_px);
        if let Some((_, url)) = self.page_cache.iter().find(|(k, _)| k == &cache_key) {
            return Ok(url.clone());
        }

        let doc = self.docs.get(doc_id).ok_or("Document not open in PDFium")?;
        let doc_ptr = doc.handle as *mut c_void;
        let lib = self.lib.as_ref().ok_or("pdfium.dll not loaded")?;

        let png_bytes = unsafe {
            let load_page: Symbol<unsafe extern "C" fn(*mut c_void, c_int) -> *mut c_void> =
                lib.get(b"FPDF_LoadPage\0").map_err(|e| e.to_string())?;
            let close_page: Symbol<unsafe extern "C" fn(*mut c_void)> =
                lib.get(b"FPDF_ClosePage\0").map_err(|e| e.to_string())?;
            let bmp_create: Symbol<unsafe extern "C" fn(c_int, c_int, c_int) -> *mut c_void> =
                lib.get(b"FPDFBitmap_Create\0").map_err(|e| e.to_string())?;
            let bmp_fill: Symbol<
                unsafe extern "C" fn(*mut c_void, c_int, c_int, c_int, c_int, u32),
            > = lib
                .get(b"FPDFBitmap_FillRect\0")
                .map_err(|e| e.to_string())?;
            let render_bmp: Symbol<
                unsafe extern "C" fn(
                    *mut c_void,
                    *mut c_void,
                    c_int,
                    c_int,
                    c_int,
                    c_int,
                    c_int,
                    c_int,
                ),
            > = lib
                .get(b"FPDF_RenderPageBitmap\0")
                .map_err(|e| e.to_string())?;
            let bmp_buf: Symbol<unsafe extern "C" fn(*mut c_void) -> *mut u8> = lib
                .get(b"FPDFBitmap_GetBuffer\0")
                .map_err(|e| e.to_string())?;
            let bmp_stride: Symbol<unsafe extern "C" fn(*mut c_void) -> c_int> = lib
                .get(b"FPDFBitmap_GetStride\0")
                .map_err(|e| e.to_string())?;
            let bmp_destroy: Symbol<unsafe extern "C" fn(*mut c_void)> = lib
                .get(b"FPDFBitmap_Destroy\0")
                .map_err(|e| e.to_string())?;

            let page_idx = (page_num.saturating_sub(1)) as c_int;
            let page = load_page(doc_ptr, page_idx);
            if page.is_null() {
                return Err(format!("FPDF_LoadPage failed for page {}", page_num));
            }

            let w = width_px.clamp(64, 4096) as c_int;
            let h = height_px.clamp(64, 4096) as c_int;
            let bmp = bmp_create(w, h, 0);
            if bmp.is_null() {
                close_page(page);
                return Err("FPDFBitmap_Create failed".into());
            }

            bmp_fill(bmp, 0, 0, w, h, 0xFFFF_FFFF);
            // Flags: FPDF_ANNOT (0x01) | FPDF_LCD_TEXT (0x02)
            render_bmp(bmp, page, 0, 0, w, h, 0, 0x01 | 0x02);

            let buf_ptr = bmp_buf(bmp);
            let stride = bmp_stride(bmp) as usize;
            let wu = w as usize;
            let hu = h as usize;

            let mut rgb = Vec::with_capacity(wu * hu * 3);
            for y in 0..hu {
                let row = std::slice::from_raw_parts(buf_ptr.add(y * stride), wu * 4);
                for px in row.chunks_exact(4) {
                    // PDFium bitmap is BGRA -> convert to RGB
                    rgb.push(px[2]);
                    rgb.push(px[1]);
                    rgb.push(px[0]);
                }
            }

            bmp_destroy(bmp);
            close_page(page);

            let mut out = Vec::with_capacity(wu * hu / 2);
            let encoder =
                PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::NoFilter);
            encoder
                .write_image(&rgb, wu as u32, hu as u32, ExtendedColorType::Rgb8)
                .map_err(|e| e.to_string())?;
            out
        };

        let data_url = format!("data:image/png;base64,{}", BASE64.encode(&png_bytes));
        if self.page_cache.len() >= 24 {
            self.page_cache.pop_front();
        }
        self.page_cache.push_back((cache_key, data_url.clone()));
        Ok(data_url)
    }
}

fn sha256_hex(s: &str) -> String {
    let mut h = Sha256::new();
    h.update(s.as_bytes());
    hex::encode(h.finalize())
}

fn init_sqlite_mirror(db_path: &Path) -> Result<(usize, usize), String> {
    if let Some(parent) = db_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS pdf_notes_mirror (
            pdf_id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            digest TEXT NOT NULL,
            sha256_content TEXT NOT NULL,
            sha256_digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS annotation_notes_mirror (
            id TEXT PRIMARY KEY,
            annotation_id TEXT NOT NULL,
            note_html TEXT NOT NULL,
            sha256_html TEXT NOT NULL,
            order_index INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS annotations_mirror (
            id TEXT PRIMARY KEY,
            pdf_file_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            rects_json TEXT NOT NULL,
            highlighted_text TEXT NOT NULL,
            hex_color TEXT NOT NULL,
            highlight_mode TEXT NOT NULL,
            created_at TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS drawings_mirror (
            id TEXT PRIMARY KEY,
            pdf_file_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            strokes_json TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS bookmarks_mirror (
            id TEXT PRIMARY KEY,
            pdf_file_id TEXT NOT NULL,
            page INTEGER NOT NULL,
            title TEXT NOT NULL,
            level INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS folder_notes_mirror (
            folder_id TEXT PRIMARY KEY,
            notes_html TEXT NOT NULL,
            sha256_html TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        );
        CREATE TABLE IF NOT EXISTS notepad_history_mirror (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pdf_id TEXT NOT NULL,
            ts INTEGER NOT NULL,
            content TEXT NOT NULL,
            digest TEXT NOT NULL,
            sha256_content TEXT NOT NULL,
            sha256_digest TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox_mirror (
            qid TEXT PRIMARY KEY,
            seq INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ann_pdf ON annotations_mirror(pdf_file_id);
        CREATE INDEX IF NOT EXISTS idx_ann_notes_ann ON annotation_notes_mirror(annotation_id);
        CREATE INDEX IF NOT EXISTS idx_draw_pdf ON drawings_mirror(pdf_file_id);
        CREATE INDEX IF NOT EXISTS idx_bm_pdf ON bookmarks_mirror(pdf_file_id);
        CREATE INDEX IF NOT EXISTS idx_np_hist_pdf ON notepad_history_mirror(pdf_id, ts);",
    )
    .map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "ALTER TABLE annotation_notes_mirror ADD COLUMN order_index INTEGER DEFAULT 0",
        [],
    );

    let existing_count: usize = conn
        .query_row("SELECT COUNT(*) FROM pdf_notes_mirror", [], |r| r.get(0))
        .unwrap_or(0);

    // Seed from latest local fidelity snapshot if empty
    if existing_count == 0 {
        let snap_dir = PathBuf::from(r"D:\Code\legal-annotator-desktop\tools\fidelity\snapshot");
        if let Ok(entries) = fs::read_dir(&snap_dir) {
            let mut files: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|x| x.path()))
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("json"))
                .collect();
            files.sort();
            if let Some(latest) = files.pop() {
                if let Ok(raw) = fs::read_to_string(&latest) {
                    if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
                        let tx = conn.transaction().map_err(|e| e.to_string())?;
                        if let Some(pdf_notes) =
                            json.pointer("/tables/pdf_notes").and_then(|v| v.as_array())
                        {
                            for row in pdf_notes {
                                let pdf_id = row
                                    .get("pdf_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                if pdf_id.is_empty() {
                                    continue;
                                }
                                let content = row
                                    .get("content")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let digest = row
                                    .get("digest")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let _ = tx.execute(
                                    "INSERT OR REPLACE INTO pdf_notes_mirror (pdf_id, content, digest, sha256_content, sha256_digest) VALUES (?1, ?2, ?3, ?4, ?5)",
                                    params![pdf_id, content, digest, sha256_hex(content), sha256_hex(digest)],
                                );
                            }
                        }
                        if let Some(ann_notes) = json
                            .pointer("/tables/annotation_notes")
                            .and_then(|v| v.as_array())
                        {
                            for row in ann_notes {
                                let id =
                                    row.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                                if id.is_empty() {
                                    continue;
                                }
                                let ann_id = row
                                    .get("annotation_id")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let note_html = row
                                    .get("note_html")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or_default();
                                let _ = tx.execute(
                                    "INSERT OR REPLACE INTO annotation_notes_mirror (id, annotation_id, note_html, sha256_html) VALUES (?1, ?2, ?3, ?4)",
                                    params![id, ann_id, note_html, sha256_hex(note_html)],
                                );
                            }
                        }
                        let _ = tx.commit();
                    }
                }
            }
        }
    }

    let n_pdf: usize = conn
        .query_row("SELECT COUNT(*) FROM pdf_notes_mirror", [], |r| r.get(0))
        .unwrap_or(0);
    let n_ann: usize = conn
        .query_row("SELECT COUNT(*) FROM annotation_notes_mirror", [], |r| {
            r.get(0)
        })
        .unwrap_or(0);
    Ok((n_pdf, n_ann))
}

#[tauri::command]
async fn desktop_system_status(state: tauri::State<'_, AppState>) -> Result<SystemStatus, String> {
    let pdfium_loaded = state
        .pdfium
        .lock()
        .map(|g| g.lib.is_some())
        .unwrap_or(false);
    let (sqlite_notes, sqlite_ann_notes) =
        init_sqlite_mirror(&state.sqlite_path).unwrap_or((0, 0));
    let cached_pdfs = fs::read_dir(&state.pdf_cache_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok())
                .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("pdf"))
                .count()
        })
        .unwrap_or(0);
    Ok(SystemStatus {
        available: true,
        pdfium_loaded,
        engine: if pdfium_loaded {
            "PDFium C++ Native (x64)".into()
        } else {
            "WebView2 Virtualized Canvas".into()
        },
        sqlite_notes,
        sqlite_ann_notes,
        cached_pdfs,
    })
}

#[tauri::command]
async fn pdfium_open_path(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    path: String,
) -> Result<OpenPdfResponse, String> {
    let mut guard = state.pdfium.lock().map_err(|e| e.to_string())?;
    let count = guard.open_path(doc_id, &path)?;
    Ok(OpenPdfResponse {
        ok: true,
        page_count: count,
    })
}

#[tauri::command]
async fn pdfium_open_bytes(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    base64: String,
) -> Result<OpenPdfResponse, String> {
    let bytes = BASE64.decode(base64.as_bytes()).map_err(|e| e.to_string())?;
    let mut guard = state.pdfium.lock().map_err(|e| e.to_string())?;
    let count = guard.open_bytes(doc_id, bytes)?;
    Ok(OpenPdfResponse {
        ok: true,
        page_count: count,
    })
}

#[tauri::command]
async fn pdfium_render_page(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    page_num: u32,
    width_px: u32,
    height_px: u32,
) -> Result<String, String> {
    let safe_doc = sanitize_cache_id(&doc_id);
    let doc_vault = state.page_vault_dir.join(&safe_doc);
    let png_path = doc_vault.join(format!("p_{}_{}x{}.png", page_num, width_px, height_px));

    // 1. Check permanent disk page vault first (lock-free parallel read!)
    if let Ok(bytes) = fs::read(&png_path) {
        if bytes.len() > 64 {
            return Ok(format!("data:image/png;base64,{}", BASE64.encode(&bytes)));
        }
    }

    // 2. Render via PDFium and persist permanently to page_vault_dir on D: drive
    let data_url = {
        let mut guard = state.pdfium.lock().map_err(|e| e.to_string())?;
        guard.render_page_png_data_url(&doc_id, page_num, width_px, height_px)?
    };

    if let Some(b64_part) = data_url.strip_prefix("data:image/png;base64,") {
        if let Ok(raw_png) = BASE64.decode(b64_part.as_bytes()) {
            let _ = fs::create_dir_all(&doc_vault);
            let _ = fs::write(&png_path, &raw_png);
        }
    }

    Ok(data_url)
}

#[tauri::command]
async fn pdfium_pick_local_pdf() -> Result<Option<PickedPdfResponse>, String> {
    let picked = rfd::FileDialog::new()
        .set_title("Open PDF Document — Legal Annotator Desktop")
        .add_filter("PDF Document", &["pdf"])
        .pick_file();
    let Some(path_buf) = picked else {
        return Ok(None);
    };
    let name = path_buf
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("Document.pdf")
        .to_string();
    let path_str = path_buf.to_string_lossy().to_string();
    let bytes = fs::read(&path_buf).map_err(|e| e.to_string())?;
    Ok(Some(PickedPdfResponse {
        name,
        path: path_str,
        base64: BASE64.encode(&bytes),
    }))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn percent_decode_simple(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (
                (bytes[i + 1] as char).to_digit(16),
                (bytes[i + 2] as char).to_digit(16),
            ) {
                out.push(((h << 4) | l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_string()
}

fn extract_ya29_token(s: &str) -> Option<String> {
    let decoded = percent_decode_simple(s);
    for candidate in [s, decoded.as_str()] {
        if let Some(idx) = candidate.find("ya29.") {
            let rest = &candidate[idx..];
            let token: String = rest
                .chars()
                .take_while(|c| {
                    c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.'
                })
                .collect();
            if token.len() > 20 {
                return Some(token);
            }
        }
    }
    None
}

fn load_saved_oauth_token(oauth_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(oauth_path).ok()?;
    let json = serde_json::from_str::<serde_json::Value>(&raw).ok()?;
    let token = json.get("access_token")?.as_str()?.to_string();
    let saved_at = json.get("saved_at_ms")?.as_u64()?;
    if now_ms().saturating_sub(saved_at) < 52 * 60 * 1000 && token.starts_with("ya29.") {
        Some(token)
    } else {
        None
    }
}

fn save_oauth_token(oauth_path: &Path, token: &str) {
    if let Some(parent) = oauth_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({
        "access_token": token,
        "saved_at_ms": now_ms(),
    });
    if let Ok(s) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(oauth_path, s);
    }
}

const OAUTH_INIT_SCRIPT: &str = r#"
(function() {
  function reportToken(tok) {
    if (!tok || window.__TAURI_TOKEN_SENT__) return;
    window.__TAURI_TOKEN_SENT__ = true;
    try {
      window.location.replace('http://127.0.0.1:19876/__tauri_oauth?token=' + encodeURIComponent(tok));
    } catch (e) {}
  }

  function inspectPayload(val) {
    if (!val) return false;
    try {
      var s = '';
      if (typeof val === 'string') {
        s = val;
      } else if (typeof val === 'object') {
        if (val.access_token && typeof val.access_token === 'string') {
          s = val.access_token;
        } else {
          try { s = JSON.stringify(val); } catch (e) {}
        }
      }
      if (!s) return false;
      var m = s.match(/ya29\.[A-Za-z0-9_\-\.]+/);
      if (m && m[0] && m[0].length > 20) {
        reportToken(m[0]);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Intercept window postMessage events
  window.addEventListener('message', function(e) {
    try {
      if (e && e.data) inspectPayload(e.data);
    } catch (e) {}
  }, true);

  // Monitor location changes safely (NEVER call document.documentElement.innerHTML)
  function checkUrl() {
    try {
      inspectPayload(window.location.href);
      inspectPayload(window.location.hash);
      inspectPayload(window.location.search);
    } catch (e) {}
  }
  window.addEventListener('hashchange', checkUrl);
  setInterval(checkUrl, 400);

  // Provide a safe, standard fakeOpener object WITHOUT recursive Proxies
  var fakeOpener = {
    closed: false,
    location: { href: 'https://notetaking-app.pages.dev/' },
    postMessage: function(msg) {
      inspectPayload(msg);
    },
    frames: []
  };

  try {
    Object.defineProperty(window, 'opener', {
      value: fakeOpener,
      writable: true,
      configurable: true
    });
  } catch (e) {
    try { window.opener = fakeOpener; } catch (e2) {}
  }
})();
"#;

#[tauri::command]
async fn desktop_start_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    silent: Option<bool>,
) -> Result<OAuthPollResponse, String> {
    if silent.unwrap_or(false) {
        if let Some(saved) = load_saved_oauth_token(&state.oauth_path) {
            if let Ok(mut g) = state.oauth_token.lock() {
                *g = Some(saved.clone());
            }
            if let Ok(mut st) = state.oauth_status.lock() {
                *st = "success".into();
            }
            return Ok(OAuthPollResponse {
                status: "success".into(),
                access_token: Some(saved),
            });
        }
        return Ok(OAuthPollResponse {
            status: "needs_interactive".into(),
            access_token: None,
        });
    }

    if let Ok(mut g) = state.oauth_token.lock() {
        *g = None;
    }
    if let Ok(mut st) = state.oauth_status.lock() {
        *st = "pending".into();
    }

    if let Some(existing) = app.get_webview_window("google-auth") {
        let _ = existing.destroy();
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let auth_url_str = "https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=3&client_id=572567924584-qj0m9fkkkjsrgva6dj32or7esbgkqvql.apps.googleusercontent.com&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20email%20profile&redirect_uri=storagerelay%3A%2F%2Fhttps%2Fnotetaking-app.pages.dev%3Fid%3Dauth123456&prompt=select_account&response_type=token&include_granted_scopes=true";
    let parsed_url = tauri::Url::parse(auth_url_str).map_err(|e| e.to_string())?;

    let token_arc = Arc::clone(&state.oauth_token);
    let status_arc = Arc::clone(&state.oauth_status);
    let oauth_path = state.oauth_path.clone();
    let app_for_nav = app.clone();

    WebviewWindowBuilder::new(&app, "google-auth", WebviewUrl::External(parsed_url))
        .title("Sign in with Google (Gmail) — Legal Annotator")
        .inner_size(520.0, 680.0)
        .center()
        .initialization_script(OAUTH_INIT_SCRIPT)
        .on_navigation(move |url| {
            let url_str = url.as_str();
            if let Some(tok) = extract_ya29_token(url_str) {
                save_oauth_token(&oauth_path, &tok);
                if let Ok(mut g) = token_arc.lock() {
                    *g = Some(tok);
                }
                if let Ok(mut st) = status_arc.lock() {
                    *st = "success".into();
                }
                let app_clone = app_for_nav.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(80));
                    if let Some(w) = app_clone.get_webview_window("google-auth") {
                        let _ = w.close();
                    }
                });
                return false;
            }
            if url_str.starts_with("http://127.0.0.1:19876/")
                || url_str.starts_with("storagerelay://")
            {
                return false;
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    Ok(OAuthPollResponse {
        status: "pending".into(),
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_poll_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<OAuthPollResponse, String> {
    let tok_opt = state.oauth_token.lock().ok().and_then(|g| g.clone());
    if let Some(tok) = tok_opt {
        if let Some(w) = app.get_webview_window("google-auth") {
            let _ = w.close();
        }
        return Ok(OAuthPollResponse {
            status: "success".into(),
            access_token: Some(tok),
        });
    }

    let mut status = state
        .oauth_status
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "idle".into());

    if status == "pending" && app.get_webview_window("google-auth").is_none() {
        status = "closed".into();
        if let Ok(mut st) = state.oauth_status.lock() {
            *st = "closed".into();
        }
    }

    Ok(OAuthPollResponse {
        status,
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_clear_google_oauth(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    if let Ok(mut g) = state.oauth_token.lock() {
        *g = None;
    }
    if let Ok(mut st) = state.oauth_status.lock() {
        *st = "idle".into();
    }
    let _ = fs::remove_file(&state.oauth_path);
    Ok(true)
}

fn sanitize_cache_id(file_id: &str) -> String {
    file_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[tauri::command]
async fn desktop_cache_get_path(
    state: tauri::State<'_, AppState>,
    file_id: String,
) -> Result<Option<String>, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Ok(None);
    }
    let path = state.pdf_cache_dir.join(format!("{}.pdf", safe_id));
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > 100 {
            return Ok(Some(path.to_string_lossy().to_string()));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn desktop_cache_save_pdf(
    state: tauri::State<'_, AppState>,
    file_id: String,
    base64: String,
) -> Result<String, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Err("Empty file_id".into());
    }
    let _ = fs::create_dir_all(&state.pdf_cache_dir);
    let path = state.pdf_cache_dir.join(format!("{}.pdf", safe_id));
    let bytes = BASE64.decode(base64.as_bytes()).map_err(|e| e.to_string())?;
    fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
async fn desktop_cache_read_pdf(
    state: tauri::State<'_, AppState>,
    file_id: String,
) -> Result<Option<String>, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Ok(None);
    }
    let path = state.pdf_cache_dir.join(format!("{}.pdf", safe_id));
    if !path.exists() {
        return Ok(None);
    }
    let bytes = fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.len() <= 100 {
        return Ok(None);
    }
    Ok(Some(BASE64.encode(&bytes)))
}

fn decode_html_entities(s: &str) -> String {
    s.replace("&amp;", "&")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&#160;", " ")
        .replace("&nbsp;", " ")
}

#[tauri::command]
async fn desktop_gdrive_download_file(
    file_id: String,
    token: Option<String>,
) -> Result<String, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Err("Invalid Google Drive file ID".into());
    }

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    // 1. Try Google Drive API with user's OAuth token if present
    if let Some(ref tok) = token {
        if !tok.trim().is_empty() {
            let api_url = format!(
                "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                safe_id
            );
            let auth_hdr = format!("Authorization: Bearer {}", tok.trim());
            let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
            cmd.args([
                "-L",
                "--silent",
                "--max-time",
                "90",
                "-H",
                &auth_hdr,
                &api_url,
            ]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            if let Ok(out) = cmd.output() {
                if out.stdout.len() > 100 && &out.stdout[0..4] == b"%PDF" {
                    return Ok(BASE64.encode(&out.stdout));
                }
            }
        }
    }

    // 2. Fallback: Direct public/shared link download via drive.usercontent.google.com & drive.google.com/uc
    let public_urls = [
        format!(
            "https://drive.usercontent.google.com/download?id={}&export=download&confirm=t",
            safe_id
        ),
        format!(
            "https://drive.google.com/uc?export=download&id={}&confirm=t",
            safe_id
        ),
    ];

    for url in &public_urls {
        let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
        cmd.args([
            "-L",
            "--silent",
            "--max-time",
            "90",
            "-A",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            url,
        ]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);
        if let Ok(out) = cmd.output() {
            if out.stdout.len() > 100 && &out.stdout[0..4] == b"%PDF" {
                return Ok(BASE64.encode(&out.stdout));
            }
        }
    }

    Err("Could not download PDF from Google Drive. Make sure the file is shared ('Anyone with the link') or sign in again with Google Drive.".into())
}

#[tauri::command]
async fn desktop_gdrive_list_folder(
    folder_id: String,
    token: Option<String>,
) -> Result<serde_json::Value, String> {
    let safe_id = sanitize_cache_id(&folder_id);
    if safe_id.is_empty() {
        return Err("Invalid Google Drive folder ID".into());
    }

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    // 1. Try Google Drive v3 API if token has access
    if let Some(ref tok) = token {
        if !tok.trim().is_empty() {
            let api_url = format!(
                "https://www.googleapis.com/drive/v3/files?q=%27{}%27+in+parents+and+trashed=false&fields=files(id,name,mimeType)&pageSize=500&supportsAllDrives=true&includeItemsFromAllDrives=true",
                safe_id
            );
            let auth_hdr = format!("Authorization: Bearer {}", tok.trim());
            let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
            cmd.args([
                "-L",
                "--silent",
                "--max-time",
                "30",
                "-H",
                &auth_hdr,
                &api_url,
            ]);
            #[cfg(target_os = "windows")]
            cmd.creation_flags(0x08000000);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    if let Ok(val) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                        if let Some(arr) = val.get("files").and_then(|f| f.as_array()) {
                            if !arr.is_empty() {
                                return Ok(serde_json::json!({ "files": arr }));
                            }
                        }
                    }
                }
            }
        }
    }

    // 2. Fallback: Public embeddedfolderview HTML listing (works for any 'Anyone with the link' folder without OAuth)
    let embed_url = format!(
        "https://drive.google.com/embeddedfolderview?id={}#list",
        safe_id
    );
    let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
    cmd.args([
        "-L",
        "--silent",
        "--max-time",
        "30",
        "-A",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        &embed_url,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);

    let out = cmd.output().map_err(|e| e.to_string())?;
    let html = String::from_utf8_lossy(&out.stdout);
    let mut files = Vec::new();

    let marker = "id=\"entry-";
    let title_marker = "<div class=\"flip-entry-title\">";
    let mut pos = 0;
    while let Some(idx) = html[pos..].find(marker) {
        let start_id = pos + idx + marker.len();
        if let Some(end_id_rel) = html[start_id..].find('"') {
            let entry_id = &html[start_id..start_id + end_id_rel];
            let after_id = start_id + end_id_rel;
            if let Some(t_rel) = html[after_id..].find(title_marker) {
                let start_t = after_id + t_rel + title_marker.len();
                if let Some(end_t_rel) = html[start_t..].find("</div>") {
                    let raw_title = html[start_t..start_t + end_t_rel].trim();
                    let clean_title = decode_html_entities(raw_title);
                    if !entry_id.is_empty() && !clean_title.is_empty() {
                        files.push(serde_json::json!({
                            "id": entry_id,
                            "name": clean_title,
                        }));
                    }
                    pos = start_t + end_t_rel;
                    continue;
                }
            }
            pos = after_id;
        } else {
            break;
        }
    }

    Ok(serde_json::json!({ "files": files }))
}

#[tauri::command]
async fn desktop_vault_get_page_text(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    page_num: u32,
    scale_key: String,
) -> Result<Option<String>, String> {
    let safe_doc = sanitize_cache_id(&doc_id);
    let safe_scale = sanitize_cache_id(&scale_key);
    if safe_doc.is_empty() {
        return Ok(None);
    }
    let path = state
        .page_vault_dir
        .join(&safe_doc)
        .join(format!("txt_{}_{}.json", page_num, safe_scale));
    if let Ok(raw) = fs::read_to_string(&path) {
        if !raw.is_empty() {
            return Ok(Some(raw));
        }
    }
    Ok(None)
}

#[tauri::command]
async fn desktop_vault_save_page_text(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    page_num: u32,
    scale_key: String,
    json: String,
) -> Result<bool, String> {
    let safe_doc = sanitize_cache_id(&doc_id);
    let safe_scale = sanitize_cache_id(&scale_key);
    if safe_doc.is_empty() {
        return Ok(false);
    }
    let dir = state.page_vault_dir.join(&safe_doc);
    let _ = fs::create_dir_all(&dir);
    let path = dir.join(format!("txt_{}_{}.json", page_num, safe_scale));
    let _ = fs::write(&path, json.as_bytes());
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_sync_annotations(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
    annotations_json: String,
) -> Result<bool, String> {
    if pdf_file_id.is_empty() {
        return Ok(false);
    }
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&annotations_json).map_err(|e| e.to_string())?;
    let mut conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let _ = tx.execute(
        "DELETE FROM annotations_mirror WHERE pdf_file_id = ?1",
        params![&pdf_file_id],
    );
    for ann in &arr {
        let id = ann.get("id").and_then(|v| v.as_str()).unwrap_or_default();
        if id.is_empty() {
            continue;
        }
        let page = ann.get("page").and_then(|v| v.as_i64()).unwrap_or(1);
        let rects_json = ann
            .get("rects")
            .map(|v| v.to_string())
            .unwrap_or_else(|| "[]".into());
        let highlighted_text = ann
            .get("highlighted_text")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let hex_color = ann
            .get("hex_color")
            .and_then(|v| v.as_str())
            .unwrap_or("#c9a84c");
        let highlight_mode = ann
            .get("highlight_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("text");
        let created_at = ann
            .get("created_at")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let _ = tx.execute(
            "INSERT OR REPLACE INTO annotations_mirror (id, pdf_file_id, page, rects_json, highlighted_text, hex_color, highlight_mode, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![id, &pdf_file_id, page, rects_json, highlighted_text, hex_color, highlight_mode, created_at],
        );

        let _ = tx.execute(
            "DELETE FROM annotation_notes_mirror WHERE annotation_id = ?1",
            params![id],
        );
        if let Some(notes) = ann.get("notes").and_then(|v| v.as_array()) {
            for (idx, note) in notes.iter().enumerate() {
                let nid = note.get("id").and_then(|v| v.as_str()).unwrap_or_default();
                if nid.is_empty() {
                    continue;
                }
                let note_html = note
                    .get("note_html")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let order_index = note
                    .get("order_index")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(idx as i64);
                let _ = tx.execute(
                    "INSERT OR REPLACE INTO annotation_notes_mirror (id, annotation_id, note_html, sha256_html, order_index) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![nid, id, note_html, sha256_hex(note_html), order_index],
                );
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_annotations(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
) -> Result<String, String> {
    if pdf_file_id.is_empty() {
        return Ok("[]".into());
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, pdf_file_id, page, rects_json, highlighted_text, hex_color, highlight_mode, created_at
             FROM annotations_mirror WHERE pdf_file_id = ?1 ORDER BY rowid ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![&pdf_file_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, String>(5)?,
                r.get::<_, String>(6)?,
                r.get::<_, String>(7)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    for row_res in rows {
        let (id, pfid, page, rects_json, highlighted_text, hex_color, highlight_mode, created_at) =
            row_res.map_err(|e| e.to_string())?;
        let rects: serde_json::Value =
            serde_json::from_str(&rects_json).unwrap_or_else(|_| serde_json::json!([]));

        let mut note_stmt = conn
            .prepare(
                "SELECT id, annotation_id, note_html, order_index
                 FROM annotation_notes_mirror WHERE annotation_id = ?1 ORDER BY order_index ASC, rowid ASC",
            )
            .map_err(|e| e.to_string())?;
        let note_rows = note_stmt
            .query_map(params![&id], |nr| {
                Ok(serde_json::json!({
                    "id": nr.get::<_, String>(0)?,
                    "annotation_id": nr.get::<_, String>(1)?,
                    "note_html": nr.get::<_, String>(2)?,
                    "order_index": nr.get::<_, i64>(3).unwrap_or(0),
                }))
            })
            .map_err(|e| e.to_string())?;
        let mut notes = Vec::new();
        for n in note_rows.flatten() {
            notes.push(n);
        }

        out.push(serde_json::json!({
            "id": id,
            "pdf_file_id": pfid,
            "page": page,
            "rects": rects,
            "highlighted_text": highlighted_text,
            "hex_color": hex_color,
            "highlight_mode": highlight_mode,
            "created_at": created_at,
            "notes": notes,
        }));
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_sqlite_sync_drawings(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
    draw_map_json: String,
) -> Result<bool, String> {
    if pdf_file_id.is_empty() {
        return Ok(false);
    }
    let map: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&draw_map_json).map_err(|e| e.to_string())?;
    let mut conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let _ = tx.execute(
        "DELETE FROM drawings_mirror WHERE pdf_file_id = ?1",
        params![&pdf_file_id],
    );
    for (page_str, strokes_val) in map {
        if let Ok(page_num) = page_str.parse::<i64>() {
            let id = format!("draw_{}_{}", pdf_file_id, page_num);
            let strokes_json = strokes_val.to_string();
            let _ = tx.execute(
                "INSERT OR REPLACE INTO drawings_mirror (id, pdf_file_id, page, strokes_json, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![id, &pdf_file_id, page_num, strokes_json, now_ms().to_string()],
            );
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_drawings(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
) -> Result<String, String> {
    if pdf_file_id.is_empty() {
        return Ok("{}".into());
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT page, strokes_json FROM drawings_mirror WHERE pdf_file_id = ?1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![&pdf_file_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut out = serde_json::Map::new();
    for (page, strokes_json) in rows.flatten() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&strokes_json) {
            out.insert(page.to_string(), val);
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_sqlite_sync_bookmarks(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
    bookmarks_json: String,
) -> Result<bool, String> {
    if pdf_file_id.is_empty() {
        return Ok(false);
    }
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&bookmarks_json).map_err(|e| e.to_string())?;
    let mut conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let _ = tx.execute(
        "DELETE FROM bookmarks_mirror WHERE pdf_file_id = ?1",
        params![&pdf_file_id],
    );
    for (idx, bm) in arr.iter().enumerate() {
        let id = bm
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("bm_{}_{}", pdf_file_id, idx));
        let page = bm.get("page").and_then(|v| v.as_i64()).unwrap_or(1);
        let title = bm
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        let level = bm.get("level").and_then(|v| v.as_i64()).unwrap_or(0);
        let _ = tx.execute(
            "INSERT OR REPLACE INTO bookmarks_mirror (id, pdf_file_id, page, title, level) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, &pdf_file_id, page, title, level],
        );
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_bookmarks(
    state: tauri::State<'_, AppState>,
    pdf_file_id: String,
) -> Result<String, String> {
    if pdf_file_id.is_empty() {
        return Ok("[]".into());
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, pdf_file_id, page, title, level FROM bookmarks_mirror WHERE pdf_file_id = ?1 ORDER BY page ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![&pdf_file_id], |r| {
            Ok(serde_json::json!({
                "id": r.get::<_, String>(0)?,
                "pdf_file_id": r.get::<_, String>(1)?,
                "page": r.get::<_, i64>(2)?,
                "title": r.get::<_, String>(3)?,
                "level": r.get::<_, i64>(4).unwrap_or(0),
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for b in rows.flatten() {
        out.push(b);
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_sqlite_upsert_pdf_note(
    state: tauri::State<'_, AppState>,
    pdf_id: String,
    content: String,
    digest: String,
) -> Result<bool, String> {
    if pdf_id.is_empty() {
        return Ok(false);
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO pdf_notes_mirror (pdf_id, content, digest, sha256_content, sha256_digest) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![&pdf_id, &content, &digest, sha256_hex(&content), sha256_hex(&digest)],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_pdf_note(
    state: tauri::State<'_, AppState>,
    pdf_id: String,
) -> Result<Option<String>, String> {
    if pdf_id.is_empty() {
        return Ok(None);
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let res = conn.query_row(
        "SELECT content, digest FROM pdf_notes_mirror WHERE pdf_id = ?1",
        params![&pdf_id],
        |r| {
            Ok(serde_json::json!({
                "content": r.get::<_, String>(0)?,
                "digest": r.get::<_, String>(1)?,
            }))
        },
    );
    match res {
        Ok(val) => Ok(Some(val.to_string())),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn desktop_sqlite_save_folder_note(
    state: tauri::State<'_, AppState>,
    folder_id: String,
    notes_html: String,
) -> Result<bool, String> {
    if folder_id.is_empty() {
        return Ok(false);
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR REPLACE INTO folder_notes_mirror (folder_id, notes_html, sha256_html, updated_at) VALUES (?1, ?2, ?3, ?4)",
        params![&folder_id, &notes_html, sha256_hex(&notes_html), now_ms().to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_folder_note(
    state: tauri::State<'_, AppState>,
    folder_id: String,
) -> Result<Option<String>, String> {
    if folder_id.is_empty() {
        return Ok(None);
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let res = conn.query_row(
        "SELECT notes_html FROM folder_notes_mirror WHERE folder_id = ?1",
        params![&folder_id],
        |r| r.get::<_, String>(0),
    );
    match res {
        Ok(val) => Ok(Some(val)),
        Err(_) => Ok(None),
    }
}

#[tauri::command]
async fn desktop_sqlite_save_notepad_history(
    state: tauri::State<'_, AppState>,
    pdf_id: String,
    ts: i64,
    content: String,
    digest: String,
) -> Result<bool, String> {
    if pdf_id.is_empty() || (content.is_empty() && digest.is_empty()) {
        return Ok(false);
    }
    let sha_c = sha256_hex(&content);
    let sha_d = sha256_hex(&digest);
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;

    // Skip if identical to latest snapshot for this PDF
    let latest_same: bool = conn
        .query_row(
            "SELECT sha256_content, sha256_digest FROM notepad_history_mirror WHERE pdf_id = ?1 ORDER BY ts DESC, id DESC LIMIT 1",
            params![&pdf_id],
            |r| {
                let c: String = r.get(0)?;
                let d: String = r.get(1)?;
                Ok(c == sha_c && d == sha_d)
            },
        )
        .unwrap_or(false);
    if latest_same {
        return Ok(true);
    }

    conn.execute(
        "INSERT INTO notepad_history_mirror (pdf_id, ts, content, digest, sha256_content, sha256_digest) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![&pdf_id, ts, &content, &digest, &sha_c, &sha_d],
    )
    .map_err(|e| e.to_string())?;

    // Keep latest 50 snapshots per PDF
    let _ = conn.execute(
        "DELETE FROM notepad_history_mirror WHERE pdf_id = ?1 AND id NOT IN (SELECT id FROM notepad_history_mirror WHERE pdf_id = ?1 ORDER BY ts DESC, id DESC LIMIT 50)",
        params![&pdf_id],
    );
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_notepad_history(
    state: tauri::State<'_, AppState>,
    pdf_id: String,
) -> Result<String, String> {
    if pdf_id.is_empty() {
        return Ok("[]".into());
    }
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT ts, content, digest FROM notepad_history_mirror WHERE pdf_id = ?1 ORDER BY ts ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![&pdf_id], |r| {
            Ok(serde_json::json!({
                "t": r.get::<_, i64>(0)?,
                "content": r.get::<_, String>(1)?,
                "digest": r.get::<_, String>(2)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for item in rows.flatten() {
        out.push(item);
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

#[tauri::command]
async fn desktop_sqlite_save_outbox(
    state: tauri::State<'_, AppState>,
    queue_json: String,
) -> Result<bool, String> {
    let arr: Vec<serde_json::Value> =
        serde_json::from_str(&queue_json).map_err(|e| e.to_string())?;
    let mut conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let _ = tx.execute("DELETE FROM outbox_mirror", []);
    for (idx, item) in arr.iter().enumerate() {
        let qid = item
            .get("qid")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("q_{}_{}", now_ms(), idx));
        let payload_str = item.to_string();
        let _ = tx.execute(
            "INSERT OR REPLACE INTO outbox_mirror (qid, seq, payload_json) VALUES (?1, ?2, ?3)",
            params![qid, idx as i64, payload_str],
        );
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn desktop_sqlite_load_outbox(state: tauri::State<'_, AppState>) -> Result<String, String> {
    let conn = Connection::open(&state.sqlite_path).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT payload_json FROM outbox_mirror ORDER BY seq ASC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for raw in rows.flatten() {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&raw) {
            out.push(val);
        }
    }
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

const EMBEDDED_VERSION_JSON: &str = include_str!("../../version.json");

#[tauri::command]
async fn desktop_check_github_update() -> Result<serde_json::Value, String> {
    let local_val: serde_json::Value =
        serde_json::from_str(EMBEDDED_VERSION_JSON).unwrap_or_else(|_| serde_json::json!({}));
    let local_build = local_val.get("build").and_then(|v| v.as_u64()).unwrap_or(1);
    let local_version = local_val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();

    let url = format!(
        "https://raw.githubusercontent.com/larxe1/Legal-Annotator-App/main/version.json?t={}",
        now_ms()
    );

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
    cmd.args([
        "-fsSL",
        "--max-time",
        "10",
        "-H",
        "Cache-Control: no-cache",
        "-H",
        "Pragma: no-cache",
        &url,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("curl error: {e}"))?;
    if !output.status.success() {
        return Ok(serde_json::json!({
            "hasUpdate": false,
            "localBuild": local_build,
            "localVersion": local_version,
            "error": String::from_utf8_lossy(&output.stderr).to_string()
        }));
    }

    let remote_str = String::from_utf8_lossy(&output.stdout);
    let remote_val: serde_json::Value =
        serde_json::from_str(&remote_str).map_err(|e| format!("invalid remote version.json: {e}"))?;
    let remote_build = remote_val.get("build").and_then(|v| v.as_u64()).unwrap_or(0);
    let remote_version = remote_val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();
    let notes = remote_val
        .get("notes")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let updated_at = remote_val
        .get("updatedAt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let download_url = remote_val
        .get("downloadUrl")
        .and_then(|v| v.as_str())
        .unwrap_or("https://github.com/larxe1/Legal-Annotator-App/raw/main/Legal%20Annotator.exe")
        .to_string();

    Ok(serde_json::json!({
        "hasUpdate": remote_build > local_build,
        "localBuild": local_build,
        "localVersion": local_version,
        "remoteBuild": remote_build,
        "remoteVersion": remote_version,
        "notes": notes,
        "updatedAt": updated_at,
        "downloadUrl": download_url
    }))
}

#[tauri::command]
async fn desktop_apply_github_update(download_url: Option<String>) -> Result<String, String> {
    let url = download_url.unwrap_or_else(|| {
        "https://github.com/larxe1/Legal-Annotator-App/raw/main/Legal%20Annotator.exe".to_string()
    });
    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let new_exe = current_exe.with_extension("new.exe");
    let old_exe = current_exe.with_extension("old.exe");

    let _ = fs::remove_file(&new_exe);

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let new_exe_str = new_exe.to_string_lossy().to_string();
    let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
    cmd.args([
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--max-time",
        "240",
        "-H",
        "Cache-Control: no-cache",
        "-H",
        "Pragma: no-cache",
        "-o",
        &new_exe_str,
        &url,
    ]);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW

    let output = cmd.output().map_err(|e| format!("Failed to start download: {e}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(&new_exe);
        return Err(format!(
            "Download failed: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }

    // Verify downloaded file is a valid Windows PE binary (> 10 MB and starts with 'MZ')
    let meta = fs::metadata(&new_exe).map_err(|e| format!("Missing downloaded file: {e}"))?;
    if meta.len() < 10_000_000 {
        let _ = fs::remove_file(&new_exe);
        return Err(format!(
            "Downloaded file is too small ({} bytes), aborting update for safety.",
            meta.len()
        ));
    }
    let header = fs::read(&new_exe).map_err(|e| e.to_string())?;
    if header.len() < 2 || &header[0..2] != b"MZ" {
        let _ = fs::remove_file(&new_exe);
        return Err("Downloaded file is not a valid Windows executable.".to_string());
    }
    drop(header);

    // Swap executable in-place on Windows: rename running .exe -> .old.exe, then .new.exe -> .exe
    let _ = fs::remove_file(&old_exe);
    if let Err(rename_err) = fs::rename(&current_exe, &old_exe) {
        let _ = fs::remove_file(&new_exe);
        return Err(format!("Could not rename running executable: {rename_err}"));
    }
    if let Err(swap_err) = fs::rename(&new_exe, &current_exe) {
        // Rollback if swap failed
        let _ = fs::rename(&old_exe, &current_exe);
        return Err(format!("Could not activate new executable: {swap_err}"));
    }

    // Spawn the newly updated executable and exit current process
    let launch_exe = current_exe.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        let _ = std::process::Command::new(&launch_exe).spawn();
        std::process::exit(0);
    });

    Ok("Update installed! Restarting Legal Annotator…".to_string())
}

fn main() {
    // Clean up any leftover .old.exe from a previous self-update
    if let Ok(cur_exe) = std::env::current_exe() {
        let old_exe = cur_exe.with_extension("old.exe");
        if old_exe.exists() {
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(1200));
                let _ = fs::remove_file(old_exe);
            });
        }
    }

    let data_dir = resolve_data_dir();
    let sqlite_path = data_dir.join("notes_mirror.sqlite");
    let pdf_cache_dir = data_dir.join("pdf_cache");
    let page_vault_dir = data_dir.join("page_vault");
    let oauth_path = data_dir.join("google_oauth.json");
    let _ = fs::create_dir_all(&pdf_cache_dir);
    let _ = fs::create_dir_all(&page_vault_dir);
    let _ = init_sqlite_mirror(&sqlite_path);

    let initial_tok = load_saved_oauth_token(&oauth_path);
    let initial_status = if initial_tok.is_some() {
        "success".to_string()
    } else {
        "idle".to_string()
    };

    let app_state = AppState {
        pdfium: Mutex::new(PdfiumHolder::new(&data_dir)),
        sqlite_path,
        pdf_cache_dir,
        page_vault_dir,
        oauth_path,
        oauth_token: Arc::new(Mutex::new(initial_tok)),
        oauth_status: Arc::new(Mutex::new(initial_status)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            desktop_system_status,
            pdfium_open_path,
            pdfium_open_bytes,
            pdfium_render_page,
            pdfium_pick_local_pdf,
            desktop_start_google_oauth,
            desktop_poll_google_oauth,
            desktop_clear_google_oauth,
            desktop_cache_get_path,
            desktop_cache_save_pdf,
            desktop_cache_read_pdf,
            desktop_gdrive_download_file,
            desktop_gdrive_list_folder,
            desktop_vault_get_page_text,
            desktop_vault_save_page_text,
            desktop_sqlite_sync_annotations,
            desktop_sqlite_load_annotations,
            desktop_sqlite_sync_drawings,
            desktop_sqlite_load_drawings,
            desktop_sqlite_sync_bookmarks,
            desktop_sqlite_load_bookmarks,
            desktop_sqlite_upsert_pdf_note,
            desktop_sqlite_load_pdf_note,
            desktop_sqlite_save_folder_note,
            desktop_sqlite_load_folder_note,
            desktop_sqlite_save_notepad_history,
            desktop_sqlite_load_notepad_history,
            desktop_sqlite_save_outbox,
            desktop_sqlite_load_outbox,
            desktop_check_github_update,
            desktop_apply_github_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Legal Annotator Desktop");
}
