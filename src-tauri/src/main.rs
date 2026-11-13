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

mod gemini_studio;
mod ocr_studio;
mod print_studio;

struct RawPdfDoc {
    handle: usize,
    _backing_bytes: Option<PinVec>,
}

struct PinVec(#[allow(dead_code)] Box<[u8]>);

pub(crate) struct PdfiumHolder {
    lib: Option<Library>,
    docs: HashMap<String, RawPdfDoc>,
    page_cache: VecDeque<(String, String)>, // (cache_key, data_url)
}

unsafe impl Send for PdfiumHolder {}

pub(crate) struct AppState {
    pub(crate) pdfium: Mutex<PdfiumHolder>,
    pub(crate) sqlite_path: PathBuf,
    pub(crate) pdf_cache_dir: PathBuf,
    pub(crate) page_vault_dir: PathBuf,
    pub(crate) oauth_path: PathBuf,
    pub(crate) oauth_token: Arc<Mutex<Option<String>>>,
    pub(crate) oauth_status: Arc<Mutex<String>>,
    pub(crate) syllabus_oauth_path: PathBuf,
    pub(crate) syllabus_oauth_token: Arc<Mutex<Option<String>>>,
    pub(crate) syllabus_oauth_status: Arc<Mutex<String>>,
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

pub(crate) fn resolve_data_dir() -> PathBuf {
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

pub(crate) fn find_pdfium_dll(data_dir: &Path) -> Option<PathBuf> {
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

    fn render_page_bgra(
        &self,
        doc_id: &str,
        page_num: u32,
        width_px: u32,
        height_px: u32,
    ) -> Result<(Vec<u8>, u32, u32), String> {
        let doc = self.docs.get(doc_id).ok_or("Document not open in PDFium")?;
        let doc_ptr = doc.handle as *mut c_void;
        let lib = self.lib.as_ref().ok_or("pdfium.dll not loaded")?;

        unsafe {
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

            let mut bgra = Vec::with_capacity(wu * hu * 4);
            for y in 0..hu {
                let row = std::slice::from_raw_parts(buf_ptr.add(y * stride), wu * 4);
                bgra.extend_from_slice(row);
            }

            bmp_destroy(bmp);
            close_page(page);

            Ok((bgra, wu as u32, hu as u32))
        }
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

#[cfg(target_os = "windows")]
pub(crate) fn run_windows_ocr_on_bgra(bgra: &[u8], width: u32, height: u32) -> Result<serde_json::Value, String> {
    unsafe {
        extern "system" {
            fn CoInitializeEx(pv: *const std::ffi::c_void, flags: u32) -> i32;
        }
        let _ = CoInitializeEx(std::ptr::null(), 0);
    }

    use windows::{
        core::HSTRING,
        Globalization::Language,
        Graphics::Imaging::{BitmapAlphaMode, BitmapPixelFormat, SoftwareBitmap},
        Media::Ocr::OcrEngine,
        Security::Cryptography::CryptographicBuffer,
    };

    let ibuf = CryptographicBuffer::CreateFromByteArray(bgra)
        .map_err(|e| format!("CryptographicBuffer error: {e}"))?;

    let bitmap = SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
        &ibuf,
        BitmapPixelFormat::Bgra8,
        width as i32,
        height as i32,
        BitmapAlphaMode::Ignore,
    )
    .or_else(|_| {
        SoftwareBitmap::CreateCopyWithAlphaFromBuffer(
            &ibuf,
            BitmapPixelFormat::Bgra8,
            width as i32,
            height as i32,
            BitmapAlphaMode::Premultiplied,
        )
    })
    .map_err(|e| format!("SoftwareBitmap error: {e}"))?;

    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .ok()
        .or_else(|| {
            let lang = Language::CreateLanguage(&HSTRING::from("en-US")).ok()?;
            OcrEngine::TryCreateFromLanguage(&lang).ok()
        })
        .or_else(|| {
            let langs = OcrEngine::AvailableRecognizerLanguages().ok()?;
            let first = langs.into_iter().next()?;
            OcrEngine::TryCreateFromLanguage(&first).ok()
        })
        .ok_or_else(|| "Failed to initialize Windows OCR engine (no compatible OCR language pack)".to_string())?;

    let operation = engine
        .RecognizeAsync(&bitmap)
        .map_err(|e| format!("OcrEngine RecognizeAsync error: {e}"))?;

    let result = operation
        .get()
        .map_err(|e| format!("OcrResult get error: {e}"))?;

    let lines_view = result
        .Lines()
        .map_err(|e| format!("OcrResult Lines error: {e}"))?;

    let w_f64 = width as f64;
    let h_f64 = height as f64;

    let mut lines_json = Vec::new();
    for line in lines_view {
        let words_view = line
            .Words()
            .map_err(|e| format!("OcrLine Words error: {e}"))?;

        let mut words_json = Vec::new();
        let mut min_x = f64::MAX;
        let mut min_y = f64::MAX;
        let mut max_x = f64::MIN;
        let mut max_y = f64::MIN;
        let mut has_words = false;

        for word in words_view {
            let w_text = word.Text().map(|h| h.to_string()).unwrap_or_default();
            let rect = word
                .BoundingRect()
                .map_err(|e| format!("OcrWord BoundingRect error: {e}"))?;

            let wx = rect.X as f64;
            let wy = rect.Y as f64;
            let ww = rect.Width as f64;
            let wh = rect.Height as f64;

            if wx < min_x { min_x = wx; }
            if wy < min_y { min_y = wy; }
            if wx + ww > max_x { max_x = wx + ww; }
            if wy + wh > max_y { max_y = wy + wh; }
            has_words = true;

            let wrx = if w_f64 > 0.0 { wx / w_f64 } else { 0.0 };
            let wry = if h_f64 > 0.0 { wy / h_f64 } else { 0.0 };
            let wrw = if w_f64 > 0.0 { ww / w_f64 } else { 0.0 };
            let wrh = if h_f64 > 0.0 { wh / h_f64 } else { 0.0 };

            words_json.push(serde_json::json!({
                "str": w_text,
                "x": wx,
                "y": wy,
                "w": ww,
                "h": wh,
                "rx": wrx,
                "ry": wry,
                "rw": wrw,
                "rh": wrh
            }));
        }

        let line_text = line.Text().map(|h| h.to_string()).unwrap_or_else(|_| {
            words_json
                .iter()
                .filter_map(|w| w.get("str").and_then(|s| s.as_str()))
                .collect::<Vec<_>>()
                .join(" ")
        });

        let (lx, ly, lw, lh) = if has_words {
            (min_x, min_y, (max_x - min_x).max(0.0), (max_y - min_y).max(0.0))
        } else {
            (0.0, 0.0, 0.0, 0.0)
        };

        let lrx = if w_f64 > 0.0 { lx / w_f64 } else { 0.0 };
        let lry = if h_f64 > 0.0 { ly / h_f64 } else { 0.0 };
        let lrw = if w_f64 > 0.0 { lw / w_f64 } else { 0.0 };
        let lrh = if h_f64 > 0.0 { lh / h_f64 } else { 0.0 };

        lines_json.push(serde_json::json!({
            "str": line_text,
            "x": lx,
            "y": ly,
            "w": lw,
            "h": lh,
            "rx": lrx,
            "ry": lry,
            "rw": lrw,
            "rh": lrh,
            "words": words_json
        }));
    }

    let full_text = result.Text().map(|h| h.to_string()).unwrap_or_else(|_| {
        lines_json
            .iter()
            .filter_map(|l| l.get("str").and_then(|s| s.as_str()))
            .collect::<Vec<_>>()
            .join("\n")
    });

    Ok(serde_json::json!({
        "fullText": full_text,
        "width": width,
        "height": height,
        "lines": lines_json
    }))
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn run_windows_ocr_on_bgra(_bgra: &[u8], _width: u32, _height: u32) -> Result<serde_json::Value, String> {
    Err("Windows Native OCR is only supported on Windows".into())
}

#[tauri::command]
async fn desktop_ocr_page(
    state: tauri::State<'_, AppState>,
    doc_id: String,
    page_num: u32,
    width_px: u32,
    height_px: u32,
) -> Result<serde_json::Value, String> {
    let (bgra, w, h) = {
        let mut guard = state.pdfium.lock().map_err(|e| e.to_string())?;
        if !guard.docs.contains_key(&doc_id) {
            let safe_id = sanitize_cache_id(&doc_id);
            let candidate = state.pdf_cache_dir.join(format!("{}.pdf", safe_id));
            if candidate.exists() {
                let _ = guard.open_path(doc_id.clone(), &candidate.to_string_lossy());
            }
        }
        guard.render_page_bgra(&doc_id, page_num, width_px, height_px)?
    };
    run_windows_ocr_on_bgra(&bgra, w, h)
}

#[tauri::command]
async fn desktop_ocr_png(png_base64: String) -> Result<serde_json::Value, String> {
    let clean_b64 = if let Some(stripped) = png_base64.strip_prefix("data:image/png;base64,") {
        stripped
    } else if let Some(stripped) = png_base64.strip_prefix("data:image/jpeg;base64,") {
        stripped
    } else {
        &png_base64
    };

    let raw_bytes = BASE64
        .decode(clean_b64.trim().as_bytes())
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    let dynamic_img = image::load_from_memory(&raw_bytes)
        .map_err(|e| format!("Failed to load image: {e}"))?;
    let rgba = dynamic_img.to_rgba8();
    let (w, h) = rgba.dimensions();

    let raw_slice = rgba.as_raw();
    let mut bgra = Vec::with_capacity(raw_slice.len());
    for px in raw_slice.chunks_exact(4) {
        bgra.push(px[2]); // B
        bgra.push(px[1]); // G
        bgra.push(px[0]); // R
        bgra.push(px[3]); // A
    }

    run_windows_ocr_on_bgra(&bgra, w, h)
}

#[tauri::command]
async fn desktop_save_searchable_pdf(
    default_name: String,
    base64: String,
    overwrite_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let clean_b64 = base64
        .strip_prefix("data:application/pdf;base64,")
        .unwrap_or(&base64);
    let bytes = BASE64
        .decode(clean_b64.trim().as_bytes())
        .map_err(|e| format!("Base64 decode failed: {e}"))?;

    if let Some(ref p) = overwrite_path {
        let p_buf = PathBuf::from(p);
        if p_buf.exists() {
            fs::write(&p_buf, &bytes).map_err(|e| format!("Failed to overwrite PDF: {e}"))?;
            return Ok(serde_json::json!({
                "ok": true,
                "path": p,
                "overwritten": true
            }));
        }
    }

    let safe_default = if default_name.ends_with(".pdf") {
        default_name
    } else {
        format!("{default_name}.pdf")
    };

    let picked = rfd::FileDialog::new()
        .set_title("Save OCR-Ready Searchable PDF")
        .set_file_name(&safe_default)
        .add_filter("PDF Document", &["pdf"])
        .save_file();

    let Some(path_buf) = picked else {
        return Ok(serde_json::json!({ "ok": false, "cancelled": true }));
    };

    let path_str = path_buf.to_string_lossy().to_string();
    fs::write(&path_buf, &bytes).map_err(|e| format!("Failed to write PDF: {e}"))?;
    Ok(serde_json::json!({
        "ok": true,
        "path": path_str,
        "overwritten": false
    }))
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

pub(crate) fn now_ms() -> u64 {
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

fn load_saved_oauth_email(oauth_path: &Path, default_email: &str) -> String {
    if let Ok(raw) = fs::read_to_string(oauth_path) {
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(em) = json.get("email").and_then(|v| v.as_str()) {
                let trimmed = em.trim();
                if !trimmed.is_empty() && trimmed.contains('@') {
                    return trimmed.to_string();
                }
            }
        }
    }
    default_email.to_string()
}

fn save_oauth_token(oauth_path: &Path, token: &str, email_opt: Option<&str>) {
    if let Some(parent) = oauth_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let existing_email = load_saved_oauth_email(oauth_path, "");
    let final_email = email_opt
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.contains('@'))
        .unwrap_or(existing_email.as_str());
    let payload = serde_json::json!({
        "access_token": token,
        "saved_at_ms": now_ms(),
        "email": final_email,
    });
    if let Ok(s) = serde_json::to_string_pretty(&payload) {
        let _ = fs::write(oauth_path, s);
    }
}

fn url_encode_param(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.' {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
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

  function reportError(err) {
    if (window.__TAURI_TOKEN_SENT__) return;
    window.__TAURI_TOKEN_SENT__ = true;
    try {
      window.location.replace('http://127.0.0.1:19876/__tauri_oauth_error?error=' + encodeURIComponent(String(err || 'oauth_error')));
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
      if (
        s.indexOf('interaction_required') !== -1 ||
        s.indexOf('login_required') !== -1 ||
        s.indexOf('consent_required') !== -1 ||
        s.indexOf('immediate_failed') !== -1 ||
        s.indexOf('account_selection_required') !== -1
      ) {
        reportError('needs_interactive');
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
    for_syllabus: Option<bool>,
    login_hint: Option<String>,
    force_refresh: Option<bool>,
) -> Result<OAuthPollResponse, String> {
    let is_syllabus = for_syllabus.unwrap_or(false);
    let is_silent = silent.unwrap_or(false);
    let is_force = force_refresh.unwrap_or(false);

    let (target_path, target_token_arc, target_status_arc, default_email, win_label) = if is_syllabus {
        (
            state.syllabus_oauth_path.clone(),
            Arc::clone(&state.syllabus_oauth_token),
            Arc::clone(&state.syllabus_oauth_status),
            "ermataac@up.edu.ph",
            "google-auth-syllabus",
        )
    } else {
        (
            state.oauth_path.clone(),
            Arc::clone(&state.oauth_token),
            Arc::clone(&state.oauth_status),
            "ec.mataac@gmail.com",
            "google-auth",
        )
    };

    // 1. If silent and not forced, return cached token from disk immediately if <52 mins old
    if is_silent && !is_force {
        if let Some(saved) = load_saved_oauth_token(&target_path) {
            if let Ok(mut g) = target_token_arc.lock() {
                *g = Some(saved.clone());
            }
            if let Ok(mut st) = target_status_arc.lock() {
                *st = "success".into();
            }
            return Ok(OAuthPollResponse {
                status: "success".into(),
                access_token: Some(saved),
            });
        }
    }

    if let Ok(mut g) = target_token_arc.lock() {
        *g = None;
    }
    if let Ok(mut st) = target_status_arc.lock() {
        *st = "pending".into();
    }

    if let Some(existing) = app.get_webview_window(win_label) {
        let _ = existing.destroy();
        std::thread::sleep(std::time::Duration::from_millis(60));
    }

    let hint_email = login_hint
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty() && s.contains('@'))
        .unwrap_or_else(|| load_saved_oauth_email(&target_path, default_email));

    let prompt_param = if is_silent {
        "none"
    } else {
        "select_account"
    };

    let auth_url_str = format!(
        "https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=3&client_id=572567924584-qj0m9fkkkjsrgva6dj32or7esbgkqvql.apps.googleusercontent.com&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.readonly%20email%20profile&redirect_uri=storagerelay%3A%2F%2Fhttps%2Fnotetaking-app.pages.dev%3Fid%3Dauth123456&prompt={}&login_hint={}&response_type=token&include_granted_scopes=true",
        prompt_param,
        url_encode_param(&hint_email)
    );
    let parsed_url = tauri::Url::parse(&auth_url_str).map_err(|e| e.to_string())?;

    let token_arc = Arc::clone(&target_token_arc);
    let status_arc = Arc::clone(&target_status_arc);
    let oauth_path = target_path.clone();
    let app_for_nav = app.clone();
    let win_label_nav = win_label.to_string();
    let hint_for_save = hint_email.clone();

    let mut builder = WebviewWindowBuilder::new(&app, win_label, WebviewUrl::External(parsed_url))
        .title(if is_syllabus {
            "Sign in with UP Mail / Gmail for Syllabus Links — Legal Annotator"
        } else {
            "Sign in with Google (Database Drive) — Legal Annotator"
        })
        .inner_size(520.0, 680.0)
        .center()
        .visible(!is_silent)
        .focused(!is_silent)
        .skip_taskbar(is_silent)
        .initialization_script(OAUTH_INIT_SCRIPT);

    builder = builder.on_navigation(move |url| {
        let url_str = url.as_str();
        if let Some(tok) = extract_ya29_token(url_str) {
            save_oauth_token(&oauth_path, &tok, Some(&hint_for_save));
            if let Ok(mut g) = token_arc.lock() {
                *g = Some(tok);
            }
            if let Ok(mut st) = status_arc.lock() {
                *st = "success".into();
            }
            let app_clone = app_for_nav.clone();
            let lbl = win_label_nav.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(80));
                if let Some(w) = app_clone.get_webview_window(&lbl) {
                    let _ = w.close();
                }
            });
            return false;
        }
        if is_silent
            && (url_str.contains("__tauri_oauth_error")
                || url_str.contains("error=")
                || url_str.contains("ServiceLogin")
                || url_str.contains("AccountChooser"))
        {
            if let Ok(mut st) = status_arc.lock() {
                *st = "needs_interactive".into();
            }
            let app_clone = app_for_nav.clone();
            let lbl = win_label_nav.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(50));
                if let Some(w) = app_clone.get_webview_window(&lbl) {
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
    });

    builder.build().map_err(|e| e.to_string())?;

    // Safety timeout for hidden silent refresh window so it never lingers if offline or blocked
    if is_silent {
        let status_timeout_arc = Arc::clone(&target_status_arc);
        let app_timeout = app.clone();
        let lbl_timeout = win_label.to_string();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(6500));
            let still_pending = status_timeout_arc
                .lock()
                .ok()
                .map(|s| s.as_str() == "pending")
                .unwrap_or(false);
            if still_pending {
                if let Ok(mut st) = status_timeout_arc.lock() {
                    *st = "needs_interactive".into();
                }
                if let Some(w) = app_timeout.get_webview_window(&lbl_timeout) {
                    let _ = w.close();
                }
            }
        });
    }

    Ok(OAuthPollResponse {
        status: "pending".into(),
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_poll_google_oauth(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
    for_syllabus: Option<bool>,
) -> Result<OAuthPollResponse, String> {
    let is_syllabus = for_syllabus.unwrap_or(false);
    let (target_token_arc, target_status_arc, win_label) = if is_syllabus {
        (
            &state.syllabus_oauth_token,
            &state.syllabus_oauth_status,
            "google-auth-syllabus",
        )
    } else {
        (&state.oauth_token, &state.oauth_status, "google-auth")
    };

    let tok_opt = target_token_arc.lock().ok().and_then(|g| g.clone());
    if let Some(tok) = tok_opt {
        if let Some(w) = app.get_webview_window(win_label) {
            let _ = w.close();
        }
        return Ok(OAuthPollResponse {
            status: "success".into(),
            access_token: Some(tok),
        });
    }

    let mut status = target_status_arc
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_else(|| "idle".into());

    if status == "pending" && app.get_webview_window(win_label).is_none() {
        status = "closed".into();
        if let Ok(mut st) = target_status_arc.lock() {
            *st = "closed".into();
        }
    }

    Ok(OAuthPollResponse {
        status,
        access_token: None,
    })
}

#[tauri::command]
async fn desktop_clear_google_oauth(
    state: tauri::State<'_, AppState>,
    for_syllabus: Option<bool>,
) -> Result<bool, String> {
    if for_syllabus.unwrap_or(false) {
        if let Ok(mut g) = state.syllabus_oauth_token.lock() {
            *g = None;
        }
        if let Ok(mut st) = state.syllabus_oauth_status.lock() {
            *st = "idle".into();
        }
        let _ = fs::remove_file(&state.syllabus_oauth_path);
    } else {
        if let Ok(mut g) = state.oauth_token.lock() {
            *g = None;
        }
        if let Ok(mut st) = state.oauth_status.lock() {
            *st = "idle".into();
        }
        let _ = fs::remove_file(&state.oauth_path);
    }
    Ok(true)
}

#[tauri::command]
async fn desktop_open_url(url: String) -> Result<bool, String> {
    let trimmed = url.trim();
    if !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("Only http/https URLs are allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let mut cmd = std::process::Command::new(r"C:\Windows\System32\rundll32.exe");
        cmd.args(["url.dll,FileProtocolHandler", trimmed]);
        cmd.creation_flags(0x08000000);
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(true);
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Unsupported OS".into())
    }
}

static PPLX_JOB_STATE: std::sync::OnceLock<Arc<Mutex<serde_json::Value>>> = std::sync::OnceLock::new();

fn get_pplx_job_state() -> Arc<Mutex<serde_json::Value>> {
    PPLX_JOB_STATE
        .get_or_init(|| Arc::new(Mutex::new(serde_json::json!({}))))
        .clone()
}

fn pplx_prefs_path() -> PathBuf {
    resolve_data_dir().join("perplexity_studio_prefs.json")
}

fn load_pplx_prefs_disk() -> serde_json::Value {
    let p = pplx_prefs_path();
    if let Ok(raw) = fs::read_to_string(&p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            return v;
        }
    }
    serde_json::json!({
        "pinnedProjectUrl": "",
        "autoSubmit": true,
        "digestMode": "append",
        "autoSendDigest": true
    })
}

fn save_pplx_prefs_disk(prefs: &serde_json::Value) {
    let p = pplx_prefs_path();
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(s) = serde_json::to_string_pretty(prefs) {
        let _ = fs::write(&p, s);
    }
}

const PERPLEXITY_INIT_SCRIPT: &str = r#"
(function() {
  if (window.__LA_PPLX_STUDIO_LOADED__) return;
  window.__LA_PPLX_STUDIO_LOADED__ = true;

  var _state = {
    pdfId: '',
    pdfName: 'Current PDF',
    subfolderName: '',
    instructionText: '',
    pdfText: '',
    fullPromptText: '',
    pinnedProjectUrl: '',
    autoSubmit: true,
    digestMode: 'append',
    autoSendDigest: true,
    jobId: 0
  };

  try {
    if (window.__INITIAL_PPLX_JOB__ && typeof window.__INITIAL_PPLX_JOB__ === 'object') {
      for (var ik in window.__INITIAL_PPLX_JOB__) {
        if (window.__INITIAL_PPLX_JOB__[ik] !== undefined && window.__INITIAL_PPLX_JOB__[ik] !== null) {
          _state[ik] = window.__INITIAL_PPLX_JOB__[ik];
        }
      }
    }
    var cached = sessionStorage.getItem('la_pplx_state_cache');
    if (cached) {
      var parsed = JSON.parse(cached);
      if (parsed && typeof parsed === 'object') {
        var initJobId = Number(window.__INITIAL_PPLX_JOB__?.jobId || 0);
        var cachedJobId = Number(parsed.jobId || 0);
        if (cachedJobId >= initJobId) {
          for (var k in parsed) { _state[k] = parsed[k]; }
        }
      }
    }
    sessionStorage.setItem('la_pplx_state_cache', JSON.stringify(_state));
  } catch (e) {}

  function saveStateCache() {
    try {
      sessionStorage.setItem('la_pplx_state_cache', JSON.stringify(_state));
    } catch (e) {}
  }

  function toUtf8Base64(obj) {
    try {
      var jsonStr = JSON.stringify(obj);
      var bytes = new TextEncoder().encode(jsonStr);
      var bin = '';
      var chunk = 0x8000;
      for (var i = 0; i < bytes.length; i += chunk) {
        bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
      }
      return btoa(bin);
    } catch (e) {
      return '';
    }
  }

  var _bridgeQueue = [];
  var _bridgeBusy = false;
  function flushBridgeQueue() {
    if (_bridgeBusy || !_bridgeQueue.length) return;
    _bridgeBusy = true;
    var payload = _bridgeQueue.shift();
    var b64 = toUtf8Base64(payload);
    if (b64) {
      try {
        window.location.href = 'http://127.0.0.1:19876/__pplx_msg?d=' + encodeURIComponent(b64);
      } catch (e) {}
    }
    setTimeout(function() {
      _bridgeBusy = false;
      if (_bridgeQueue.length) flushBridgeQueue();
    }, 45);
  }

  function sendBridgeMsg(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.action === 'studio_status' || payload.action === 'studio_error') {
      _bridgeQueue = _bridgeQueue.filter(function(item) {
        return item.action !== 'studio_status' && item.action !== 'studio_error';
      });
    }
    _bridgeQueue.push(payload);
    flushBridgeQueue();
  }

  var _lastEmittedStatusKey = '';
  var _lastEmittedStatusAt = 0;
  function emitStudioStatus(state, stepLabel, message, canRetry, force) {
    var st = state || 'idle';
    var action = st === 'error' ? 'studio_error' : 'studio_status';
    var key = action + '|' + st + '|' + (stepLabel || '') + '|' + (message || '') + '|' + (_state.pdfId || '');
    var now = Date.now();
    if (!force && key === _lastEmittedStatusKey && (now - _lastEmittedStatusAt) < 3500) return;
    _lastEmittedStatusKey = key;
    _lastEmittedStatusAt = now;
    sendBridgeMsg({
      action: action,
      state: st,
      stepLabel: stepLabel || '',
      message: message || '',
      pdfId: _state.pdfId || '',
      canRetry: !!canRetry
    });
  }

  function syncPrefsToApp() {
    saveStateCache();
    sendBridgeMsg({
      action: 'save_prefs',
      pinnedProjectUrl: _state.pinnedProjectUrl || '',
      autoSubmit: !!_state.autoSubmit,
      digestMode: _state.digestMode === 'replace' ? 'replace' : 'append',
      autoSendDigest: !!_state.autoSendDigest
    });
  }

  function isSpaceOrCollectionUrl(u) {
    if (!u || typeof u !== 'string') return false;
    return /perplexity\.ai\/(spaces|collections)\/[A-Za-z0-9_\-]+/i.test(u);
  }

  function cleanSpaceUrl(u) {
    if (!u) return '';
    try {
      var parsed = new URL(u);
      return parsed.origin + parsed.pathname;
    } catch (e) {
      return u.split('?')[0].split('#')[0];
    }
  }

  function showStatus(msg, color) {
    var el = document.getElementById('la-pplx-status');
    if (!el) return;
    el.textContent = msg || '';
    el.style.color = color || '#fbbf24';
  }

  function updateBarUI() {
    var pdfLbl = document.getElementById('la-pplx-pdf-lbl');
    if (pdfLbl) {
      pdfLbl.textContent = '📄 ' + (_state.pdfName || 'Current PDF');
      pdfLbl.title = (_state.subfolderName ? ('Subfolder: ' + _state.subfolderName + '\n') : '') + (_state.pdfName || '');
    }

    var pinBtn = document.getElementById('la-pplx-pin-btn');
    if (pinBtn) {
      var curIsSpace = isSpaceOrCollectionUrl(window.location.href);
      if (_state.pinnedProjectUrl) {
        pinBtn.innerHTML = '📌 "Law" Pinned ✓';
        pinBtn.style.borderColor = 'rgba(201,168,76,0.6)';
        pinBtn.style.background = 'rgba(201,168,76,0.16)';
        pinBtn.style.color = '#f3d37a';
        pinBtn.title = 'Pinned Law Project: ' + _state.pinnedProjectUrl + '\n(Click while on a Space page to update pin, or click from a thread to return to your Law Project)';
      } else if (curIsSpace) {
        pinBtn.innerHTML = '📌 Pin This "Law" Project';
        pinBtn.style.borderColor = '#4ade80';
        pinBtn.style.background = 'rgba(74,222,128,0.15)';
        pinBtn.style.color = '#4ade80';
      } else {
        pinBtn.innerHTML = '📌 Pin "Law" Project';
        pinBtn.style.borderColor = '#334155';
        pinBtn.style.background = '#1e293b';
        pinBtn.style.color = '#cbd5e1';
      }
    }

    var autoSubBtn = document.getElementById('la-pplx-autosubmit-btn');
    if (autoSubBtn) {
      autoSubBtn.textContent = _state.autoSubmit ? '☑ Auto-Submit: ON' : '☐ Auto-Submit: OFF';
      autoSubBtn.style.borderColor = _state.autoSubmit ? 'rgba(201,168,76,0.5)' : '#334155';
      autoSubBtn.style.color = _state.autoSubmit ? '#f3d37a' : '#94a3b8';
    }

    var autoSendBtn = document.getElementById('la-pplx-autosend-btn');
    if (autoSendBtn) {
      var isAutoSend = _state.autoSendDigest !== false;
      autoSendBtn.textContent = isAutoSend ? '☑ Auto-Send: ON' : '☐ Auto-Send: OFF';
      autoSendBtn.style.borderColor = isAutoSend ? 'rgba(74,222,128,0.5)' : '#334155';
      autoSendBtn.style.color = isAutoSend ? '#4ade80' : '#94a3b8';
    }

    var modeBtn = document.getElementById('la-pplx-mode-btn');
    if (modeBtn) {
      var isAppend = _state.digestMode !== 'replace';
      modeBtn.textContent = isAppend ? '📥 Digest: Append (Bottom)' : '🔄 Digest: Replace';
      modeBtn.style.borderColor = isAppend ? 'rgba(96,165,250,0.45)' : 'rgba(248,113,113,0.45)';
      modeBtn.style.color = isAppend ? '#93c5fd' : '#fca5a5';
    }
  }

  function ensureStudioBar() {
    if (!document.body) return;
    if (document.getElementById('la-pplx-studio-bar')) {
      updateBarUI();
      return;
    }

    var bar = document.createElement('div');
    bar.id = 'la-pplx-studio-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:44px;background:linear-gradient(90deg,#0f172a 0%,#172542 100%);border-bottom:1.5px solid #c9a84c;z-index:2147483647;display:flex;align-items:center;gap:8px;padding:0 12px;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;font-size:12px;color:#e8e4db;box-shadow:0 4px 16px rgba(0,0,0,0.45);user-select:none;overflow-x:auto;';

    var btnStyle = 'padding:5px 9px;border-radius:5px;border:1px solid #334155;background:#1e293b;color:#e2e8f0;font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;transition:all 0.15s;display:inline-flex;align-items:center;gap:5px;';
    var goldBtnStyle = 'padding:5px 12px;border-radius:5px;border:1px solid #c9a84c;background:linear-gradient(180deg,#d4b254 0%,#b89334 100%);color:#0f172a;font-size:11.5px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;box-shadow:0 2px 8px rgba(201,168,76,0.3);display:inline-flex;align-items:center;gap:5px;';

    var svgScale = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="M5 7h14"/><path d="M5 7l-3 7h6l-3-7z"/><path d="M19 7l-3 7h6l-3-7z"/><path d="M8 21h8"/></svg>';
    var svgPin = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
    var svgSpark = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/></svg>';
    var svgCopy = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';

    bar.innerHTML =
      '<span style="color:#c9a84c;font-weight:700;font-size:12.5px;white-space:nowrap;letter-spacing:0.02em;display:inline-flex;align-items:center;gap:5px;">' + svgScale + 'Law Digest Studio</span>' +
      '<span id="la-pplx-pdf-lbl" style="max-width:190px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:rgba(255,255,255,0.06);padding:3px 8px;border-radius:4px;font-size:11px;color:#cbd5e1;">Current PDF</span>' +
      '<button id="la-pplx-pin-btn" style="' + btnStyle + '">' + svgPin + 'Pin "Law" Project</button>' +
      '<button id="la-pplx-model-btn" style="padding:5px 9px;border-radius:5px;border:1px solid rgba(192,132,252,0.55);background:rgba(192,132,252,0.14);color:#e9d5ff;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:&quot;Public Sans&quot;,&quot;Segoe UI&quot;,system-ui,sans-serif;display:inline-flex;align-items:center;gap:5px;" title="Always enforces Claude 5.5 Sonnet (or latest Claude model) before submitting. Click to force-verify model now.">' + svgSpark + 'Claude Sonnet</button>' +
      '<button id="la-pplx-autosubmit-btn" style="' + btnStyle + '" title="Toggle whether pasting a case automatically presses Submit">Auto-Submit: ON</button>' +
      '<button id="la-pplx-autosend-btn" style="' + btnStyle + '" title="Toggle whether the finished digest is automatically sent to the Case Digest tab once Perplexity finishes generating">Auto-Send: ON</button>' +
      '<button id="la-pplx-mode-btn" style="' + btnStyle + '" title="Choose whether sending to Case Digest appends at the bottom or replaces existing digest (Notes tab is never touched)">Digest: Append (Bottom)</button>' +
      '<button id="la-pplx-paste-btn" style="' + btnStyle + '" title="Paste Subfolder Instruction + PDF Text into Perplexity prompt box">' + svgCopy + 'Paste Case</button>' +
      '<span id="la-pplx-status" style="font-size:11px;color:#fbbf24;white-space:nowrap;margin-left:auto;margin-right:4px;"></span>' +
      '<button id="la-pplx-send-btn" style="' + goldBtnStyle + '" title="Send Perplexity\'s latest response directly into the Case Digest tab in Legal Annotator">' + svgScale + 'Send to Case Digest</button>';

    document.body.appendChild(bar);
    document.documentElement.style.scrollPaddingTop = '48px';
    document.body.style.paddingTop = '44px';

    // Also add floating quick-send button at bottom right so user doesn't have to scroll up
    var fab = document.createElement('button');
    fab.id = 'la-pplx-fab-send';
    fab.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:2147483646;padding:9px 15px;border-radius:999px;border:1.5px solid #c9a84c;background:#0f172a;color:#f3d37a;font-family:"Public Sans","Segoe UI",system-ui,sans-serif;font-size:12px;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,0.55);display:flex;align-items:center;gap:6px;';
    fab.innerHTML = svgScale + '<span>Send to Case Digest</span>';
    fab.title = 'Send latest Perplexity answer directly into the Case Digest tab';
    fab.addEventListener('click', function() { extractAndSendDigest(); });
    document.body.appendChild(fab);

    document.getElementById('la-pplx-pin-btn').addEventListener('click', function() {
      var curUrl = window.location.href;
      if (isSpaceOrCollectionUrl(curUrl)) {
        _state.pinnedProjectUrl = cleanSpaceUrl(curUrl);
        syncPrefsToApp();
        updateBarUI();
        showStatus('📌 Pinned "Law" Project URL!', '#4ade80');
      } else if (_state.pinnedProjectUrl) {
        showStatus('Opening pinned "Law" Project…', '#fbbf24');
        window.location.href = _state.pinnedProjectUrl;
      } else {
        if (!tryAutoNavigateToLawSpace()) {
          showStatus('👉 Click your "Law" project in Perplexity\'s sidebar first, then click Pin!', '#fbbf24');
        }
      }
    });

    document.getElementById('la-pplx-autosubmit-btn').addEventListener('click', function() {
      _state.autoSubmit = !_state.autoSubmit;
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.autoSubmit ? 'Auto-Submit enabled' : 'Auto-Submit disabled (review before pressing Enter)', '#93c5fd');
    });

    document.getElementById('la-pplx-autosend-btn').addEventListener('click', function() {
      _state.autoSendDigest = (_state.autoSendDigest === false) ? true : false;
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.autoSendDigest ? 'Auto-Send to Case Digest enabled' : 'Auto-Send disabled (use manual Send button)', '#4ade80');
    });

    document.getElementById('la-pplx-mode-btn').addEventListener('click', function() {
      _state.digestMode = (_state.digestMode === 'replace') ? 'append' : 'replace';
      syncPrefsToApp();
      updateBarUI();
      showStatus(_state.digestMode === 'replace' ? 'Digest mode: Replace existing digest' : 'Digest mode: Append at bottom', '#93c5fd');
    });

    document.getElementById('la-pplx-model-btn').addEventListener('click', function() {
      ensureClaudeModelSelected(findPromptInput(), function(modelName) {
        showStatus('🤖 Model verified: ' + (modelName || 'Claude Sonnet'), '#c084fc');
      }, true);
    });

    document.getElementById('la-pplx-paste-btn').addEventListener('click', function() {
      pasteAndMaybeSubmit(true);
    });

    document.getElementById('la-pplx-send-btn').addEventListener('click', function() {
      extractAndSendDigest();
    });

    updateBarUI();
  }

  var _spaceTransitionReadyAt = 0;

  function returnToLawSpaceHome() {
    var spaceLinks = Array.from(document.querySelectorAll('a[href*="/spaces/"], a[href*="/collections/"]')).filter(function(a) {
      return isSpaceOrCollectionUrl(a.href);
    });
    var exactLaw = spaceLinks.find(function(a) {
      return (a.textContent || '').trim().toLowerCase() === 'law';
    });
    var lawLink = exactLaw || spaceLinks.find(function(a) {
      return /\blaw\b/i.test((a.textContent || '').trim());
    }) || spaceLinks[0];

    if (lawLink && lawLink.href) {
      var clean = cleanSpaceUrl(lawLink.href);
      if (clean) {
        _state.pinnedProjectUrl = clean;
        saveStateCache();
        updateBarUI();
      }
      _spaceTransitionReadyAt = Date.now() + 900;
      lawLink.click();
      return true;
    }
    if (isSpaceOrCollectionUrl(_state.pinnedProjectUrl)) {
      _spaceTransitionReadyAt = Date.now() + 900;
      window.location.href = _state.pinnedProjectUrl;
      return true;
    }
    return false;
  }

  function tryAutoNavigateToLawSpace() {
    if (returnToLawSpaceHome()) {
      showStatus('📌 Found "Law" Project! Opening…', '#4ade80');
      return true;
    }
    return false;
  }

  function findPromptInput() {
    var onSpacePage = isSpaceOrCollectionUrl(window.location.href);
    var selectors = onSpacePage
      ? [
          'textarea[placeholder*="Law" i]',
          'textarea[placeholder*="Space" i]',
          'textarea[placeholder*="New thread" i]',
          'textarea[placeholder*="Ask" i]:not([placeholder*="follow" i])',
          'textarea:not([readonly]):not([disabled]):not([placeholder*="follow" i])',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]'
        ]
      : [
          'textarea[placeholder*="Law" i]',
          'textarea[placeholder*="Ask" i]',
          'textarea[placeholder*="New thread" i]',
          'textarea[placeholder*="follow" i]',
          'textarea:not([readonly]):not([disabled])',
          'div[contenteditable="true"][role="textbox"]',
          'div[contenteditable="true"]'
        ];
    for (var i = 0; i < selectors.length; i++) {
      var els = Array.from(document.querySelectorAll(selectors[i]));
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (!el.isConnected) continue;
        if (el.id === 'la-pplx-studio-bar' || el.closest('#la-pplx-studio-bar')) continue;
        if (onSpacePage) {
          var ph = (el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
          if (ph.indexOf('follow') !== -1) continue;
        }
        var r = el.getBoundingClientRect();
        if (r.width > 120 && r.height > 20) return el;
      }
    }
    return null;
  }

  function showClickCursorAt(x, y, labelText) {
    try {
      var ring = document.getElementById('la-pplx-click-cursor');
      if (!ring) {
        ring = document.createElement('div');
        ring.id = 'la-pplx-click-cursor';
        ring.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;transition:left 0.14s ease,top 0.14s ease,opacity 0.2s ease;display:flex;align-items:center;gap:6px;transform:translate(-12px,-12px);';
        ring.innerHTML =
          '<div style="width:24px;height:24px;border-radius:50%;border:2.5px solid #c084fc;background:rgba(192,132,252,0.28);box-shadow:0 0 14px rgba(192,132,252,0.85);"></div>' +
          '<span id="la-pplx-click-cursor-lbl" style="background:#0f172a;border:1px solid #c084fc;color:#f3e8ff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:999px;white-space:nowrap;box-shadow:0 4px 12px rgba(0,0,0,0.6);"></span>';
        document.body.appendChild(ring);
      }
      ring.style.left = Math.round(x) + 'px';
      ring.style.top = Math.round(y) + 'px';
      ring.style.opacity = '1';
      var lbl = document.getElementById('la-pplx-click-cursor-lbl');
      if (lbl) lbl.textContent = labelText || '🤖 Selecting Claude';
      clearTimeout(ring._hideTimer);
      ring._hideTimer = setTimeout(function() {
        if (ring) ring.style.opacity = '0';
      }, 1500);
    } catch (e) {}
  }

  function realPointerClick(el) {
    if (!el || !el.isConnected) return false;
    try {
      var r = el.getBoundingClientRect();
      var cx = Math.round(r.left + r.width / 2);
      var cy = Math.round(r.top + r.height / 2);
      var opts = {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: cx,
        clientY: cy,
        screenX: cx,
        screenY: cy,
        button: 0,
        buttons: 1,
        pointerId: 1,
        pointerType: 'mouse',
        isPrimary: true
      };
      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      el.dispatchEvent(new PointerEvent('pointerenter', opts));
      el.dispatchEvent(new MouseEvent('mouseenter', opts));
      el.dispatchEvent(new PointerEvent('pointermove', opts));
      el.dispatchEvent(new MouseEvent('mousemove', opts));
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      if (typeof el.focus === 'function') el.focus();
      var upOpts = Object.assign({}, opts, { buttons: 0 });
      el.dispatchEvent(new PointerEvent('pointerup', upOpts));
      el.dispatchEvent(new MouseEvent('mouseup', upOpts));
      el.dispatchEvent(new MouseEvent('click', Object.assign({}, upOpts, { detail: 1 })));
      return true;
    } catch (e) {
      try { el.click(); return true; } catch (e2) { return false; }
    }
  }

  function findModelSelectorButton(inputEl) {
    var ir = (inputEl && inputEl.isConnected) ? inputEl.getBoundingClientRect() : null;
    var allCandidates = Array.from(document.querySelectorAll('button, [role="button"], [aria-haspopup], [data-state], div, span')).filter(function(el) {
      if (!el.isConnected || el.closest('#la-pplx-studio-bar') || el.id === 'la-pplx-fab-send' || el.closest('#la-pplx-fab-send') || el.closest('#la-pplx-click-cursor')) return false;
      if (el.closest('.prose, .markdown-body, nav, aside')) return false;
      var r = el.getBoundingClientRect();
      if (r.left < 160 || r.top < 45) return false;
      if (r.width < 22 || r.width > 260 || r.height < 12 || r.height > 56) return false;
      if (ir && ir.width > 40) {
        if (r.top < ir.top - 110 || r.bottom > ir.bottom + 190) return false;
      }
      return true;
    });

    function getCleanLabel(el) {
      return ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
    }

    var matches = allCandidates.filter(function(el) {
      var txt = getCleanLabel(el);
      var aria = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.getAttribute('data-testid') || '')).toLowerCase();
      if (/^(search|computer|research|labs|share|new|law|sales|insurance|plugins|artifacts|automations|teammates|projects|recents|answer|links|images)$/i.test(txt)) return false;
      if (/^model$/i.test(txt) || /^model\s*[▾⌄∨v]?$/i.test(txt)) return true;
      if (/^(claude|sonar|gpt-|gpt\s|gemini|grok|deepseek|o1|o3|o4|r1|best|auto)\b/i.test(txt) && txt.length <= 38) return true;
      if (/\b(model|choose a model|select model)\b/i.test(aria) && aria.indexOf('submit') === -1 && aria.indexOf('attach') === -1) return true;
      return false;
    });

    // If not found near inputEl, search the whole main area for the "Model" button
    if (matches.length === 0 && ir) {
      return findModelSelectorButton(null);
    }

    if (matches.length > 0) {
      var resolved = matches.map(function(m) {
        var btnAncestor = m.closest('button, [role="button"], [aria-haspopup], [data-state]');
        if (btnAncestor && !btnAncestor.closest('#la-pplx-studio-bar')) {
          var br = btnAncestor.getBoundingClientRect();
          if (br.width >= 28 && br.width <= 260 && br.height >= 16 && br.height <= 56) {
            return btnAncestor;
          }
        }
        return m;
      });
      if (ir && ir.width > 40) {
        resolved.sort(function(a, b) {
          var ra = a.getBoundingClientRect();
          var rb = b.getBoundingClientRect();
          return Math.abs(ra.top - ir.bottom) - Math.abs(rb.top - ir.bottom);
        });
      }
      return resolved[0];
    }
    return null;
  }

  function isInsideOpenModelMenu(el, triggerEl) {
    var cur = el.parentElement;
    var depth = 0;
    while (cur && cur !== document.body && depth < 10) {
      if (cur === triggerEl) return false;
      if (cur.matches && cur.matches('[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"], [role="dialog"]')) {
        return true;
      }
      var cr = cur.getBoundingClientRect();
      if (cr.width >= 120 && cr.width <= 620 && cr.height >= 60 && cr.height <= 760) {
        var ctxt = ((cur.innerText || cur.textContent || '') + '').toLowerCase();
        if (/\b(sonar|gpt|gemini|grok|deepseek|best|auto|anthropic|openai|reasoning)\b/i.test(ctxt)) {
          return true;
        }
      }
      cur = cur.parentElement;
      depth++;
    }
    return false;
  }

  function findClaudeMenuItem(triggerEl) {
    var candidates = [];
    var nodes = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], button, a, div, span, li'));

    nodes.forEach(function(el) {
      if (!el.isConnected || el === triggerEl || (triggerEl && triggerEl.contains(el))) return;
      if (el.closest('#la-pplx-studio-bar') || el.closest('#la-pplx-fab-send') || el.closest('#la-pplx-click-cursor')) return;
      if (el.closest('.prose, .markdown-body, nav, aside')) return;

      var txt = ((el.innerText || el.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length < 4 || txt.length > 110) return;
      if (!/\bclaude\b/i.test(txt)) return;

      // Never match an outer container that holds multiple different model families
      if (/\b(sonar|gpt-|gpt\s|gemini|grok|deepseek|llama|mistral)\b/i.test(txt)) return;

      var r = el.getBoundingClientRect();
      if (r.left < 160 || r.top < 45) return;
      if (r.width < 24 || r.width > 460 || r.height < 12 || r.height > 76) return;

      if (!isInsideOpenModelMenu(el, triggerEl)) return;

      var rowEl = el.closest('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], button') || el;
      var rr = rowEl.getBoundingClientRect();
      var target = (rr.height >= 16 && rr.height <= 72 && rr.width >= 36 && rr.width <= 460) ? rowEl : el;
      var targetTxt = ((target.innerText || target.textContent || '') + '').replace(/\s+/g, ' ').trim();
      if (/\b(sonar|gpt-|gpt\s|gemini|grok|deepseek|llama|mistral)\b/i.test(targetTxt)) {
        target = el;
        targetTxt = txt;
      }

      var score = 0;
      if (target.closest('[data-radix-popper-content-wrapper], [role="menu"], [role="listbox"], [role="dialog"]')) score += 1000;
      if (/claude\s*5\.5\s*sonnet/i.test(targetTxt)) score += 600;
      else if (/claude[^,\n]*sonnet/i.test(targetTxt) && !/thinking|reasoning/i.test(targetTxt)) score += 500;
      else if (/claude[^,\n]*sonnet/i.test(targetTxt)) score += 420;
      else if (/\bclaude\b/i.test(targetTxt) && !/thinking|reasoning/i.test(targetTxt)) score += 340;
      else if (/\bclaude\b/i.test(targetTxt)) score += 300;

      if (target.matches('[role="menuitem"], [role="option"], [role="menuitemradio"], [data-radix-collection-item], button')) {
        score += 80;
      }
      if (el.children.length === 0) {
        score += 40;
      }

      candidates.push({ el: target, leafEl: el, text: targetTxt, score: score });
    });

    if (candidates.length === 0) return null;
    candidates.sort(function(a, b) { return b.score - a.score; });
    return candidates[0];
  }

  function ensureClaudeModelSelected(inputEl, callback, forceOpenMenu) {
    var done = function(label, verified) {
      var mBtn = document.getElementById('la-pplx-model-btn');
      if (mBtn) {
        if (verified !== false) {
          mBtn.textContent = '🤖 ' + (label || 'Claude Sonnet') + ' ✓';
          mBtn.style.borderColor = 'rgba(74,222,128,0.6)';
          mBtn.style.color = '#86efac';
        } else {
          mBtn.textContent = '🤖 Click to Select Claude';
          mBtn.style.borderColor = 'rgba(248,113,113,0.6)';
          mBtn.style.color = '#fca5a5';
        }
      }
      if (typeof callback === 'function') callback(label || 'Claude Sonnet');
    };

    var findAttempts = 0;
    function tryLocateAndSelect() {
      findAttempts++;
      try {
        var modelTrigger = findModelSelectorButton(inputEl || findPromptInput());
        if (!modelTrigger) {
          if (findAttempts < 8) {
            showStatus('⏳ Waiting for "Model ⌄" button…', '#c084fc');
            setTimeout(tryLocateAndSelect, 220);
            return;
          }
          showStatus('⚠️ Could not locate "Model ⌄" button yet.', '#fbbf24');
          done('Claude Sonnet', false);
          return;
        }

        var triggerTxt = ((modelTrigger.innerText || modelTrigger.textContent || '') + ' ' + (modelTrigger.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
        var alreadyShowsClaude = /\bclaude\b/i.test(triggerTxt);
        var jobKey = String(_state.jobId || 'manual');
        var alreadyVerifiedForJob = sessionStorage.getItem('la_pplx_claude_verified_job') === jobKey;

        if ((alreadyShowsClaude && alreadyVerifiedForJob) && !forceOpenMenu) {
          var cleanLbl = /5\.5/i.test(triggerTxt) ? 'Claude 5.5 Sonnet' : 'Claude Sonnet';
          done(cleanLbl, true);
          return;
        }

        // 1. Physically move OS mouse cursor to "Model ⌄" button and click it to open the dropdown
        var tr = modelTrigger.getBoundingClientRect();
        var tx = Math.round(tr.left + tr.width / 2);
        var ty = Math.round(tr.top + tr.height / 2);
        showStatus('🤖 Moving mouse to "Model ⌄" to select Claude…', '#c084fc');
        showClickCursorAt(tx, ty, 'Clicking Model ⌄');
        sendBridgeMsg({
          action: 'native_click',
          x: tx,
          y: ty,
          dpr: window.devicePixelRatio || 1
        });

        var pollAttempts = 0;
        var pollTimer = setInterval(function() {
          pollAttempts++;
          var found = findClaudeMenuItem(modelTrigger);

          if (!found && pollAttempts === 3) {
            // Backup: dispatch Radix pointerdown/click + ArrowDown on modelTrigger if menu hasn't opened yet
            realPointerClick(modelTrigger);
            try {
              modelTrigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, bubbles: true }));
            } catch (e) {}
            return;
          }

          if (!found && pollAttempts === 6) {
            var tr2 = modelTrigger.getBoundingClientRect();
            sendBridgeMsg({
              action: 'native_click',
              x: Math.round(tr2.left + tr2.width / 2),
              y: Math.round(tr2.top + tr2.height / 2),
              dpr: window.devicePixelRatio || 1
            });
            return;
          }

          if (found && found.el) {
            clearInterval(pollTimer);
            try { found.el.scrollIntoView({ block: 'nearest' }); } catch (e) {}
            var clickTargetEl = (found.leafEl && found.leafEl.isConnected) ? found.leafEl : found.el;
            var cr = clickTargetEl.getBoundingClientRect();
            var cx = Math.round(cr.left + Math.min(cr.width / 2, 80));
            var cy = Math.round(cr.top + cr.height / 2);
            var pickedLabel = /5\.5/i.test(found.text) ? 'Claude 5.5 Sonnet' : (/sonnet/i.test(found.text) ? 'Claude Sonnet' : 'Claude');

            showStatus('🤖 Selecting ' + pickedLabel + '…', '#c084fc');
            showClickCursorAt(cx, cy, 'Selecting ' + pickedLabel);

            // Physically move OS mouse cursor onto Claude in the dropdown and click it!
            sendBridgeMsg({
              action: 'native_click',
              x: cx,
              y: cy,
              dpr: window.devicePixelRatio || 1
            });

            setTimeout(function() {
              // Check if a sub-menu with specific Claude Sonnet versions opened or if menu is still open
              var subFound = findClaudeMenuItem(modelTrigger);
              if (subFound && subFound.el && subFound.el !== found.el && /sonnet/i.test(subFound.text)) {
                var subTarget = (subFound.leafEl && subFound.leafEl.isConnected) ? subFound.leafEl : subFound.el;
                var scr = subTarget.getBoundingClientRect();
                var scx = Math.round(scr.left + Math.min(scr.width / 2, 80));
                var scy = Math.round(scr.top + scr.height / 2);
                showClickCursorAt(scx, scy, 'Selecting ' + subFound.text);
                sendBridgeMsg({
                  action: 'native_click',
                  x: scx,
                  y: scy,
                  dpr: window.devicePixelRatio || 1
                });
                setTimeout(function() {
                  if (subFound.el && subFound.el.isConnected) realPointerClick(subFound.el);
                  sessionStorage.setItem('la_pplx_claude_verified_job', jobKey);
                  done(pickedLabel, true);
                }, 260);
              } else {
                if (subFound && subFound.el && found.el && found.el.isConnected) {
                  // Menu remained open after native click; fire synthetic Radix click and Escape to close menu
                  realPointerClick(found.el);
                  setTimeout(function() {
                    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
                  }, 90);
                }
                sessionStorage.setItem('la_pplx_claude_verified_job', jobKey);
                done(pickedLabel, true);
              }
            }, 260);
            return;
          }

          if (pollAttempts >= 12) {
            clearInterval(pollTimer);
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
            done('Claude Sonnet', false);
          }
        }, 160);
      } catch (e) {
        done('Claude Sonnet', false);
      }
    }

    tryLocateAndSelect();
  }

  function setInputText(inputEl, text) {
    if (!inputEl) return false;
    inputEl.focus();
    try {
      var dt = new DataTransfer();
      dt.setData('text/plain', text);
      var pasteEvt = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      });
      var cancelled = !inputEl.dispatchEvent(pasteEvt);
      if (cancelled) return true;
    } catch (e) {}

    if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
      try {
        var proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : Object.getPrototypeOf(inputEl);
        var setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(inputEl, text);
        else inputEl.value = text;
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      } catch (e) {}
    }

    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      inputEl.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {}
    return false;
  }

  function triggerSubmit(inputEl) {
    // Look for enabled submit button near the prompt box
    var container = (inputEl && (inputEl.closest('form') || inputEl.parentElement?.parentElement?.parentElement?.parentElement)) || document;
    var btnSelectors = [
      'button[aria-label*="Submit" i]:not([disabled])',
      'button[aria-label*="Send" i]:not([disabled])',
      'button[type="submit"]:not([disabled])'
    ];
    for (var i = 0; i < btnSelectors.length; i++) {
      var btn = container.querySelector(btnSelectors[i]) || document.querySelector(btnSelectors[i]);
      if (btn && !btn.disabled) {
        btn.click();
        return true;
      }
    }
    // Also check buttons inside prompt container that have an arrow/submit SVG and are not disabled
    var allBtns = Array.from(container.querySelectorAll('button:not([disabled])'));
    for (var b = allBtns.length - 1; b >= 0; b--) {
      var candidate = allBtns[b];
      if (candidate.closest('#la-pplx-studio-bar')) continue;
      var aria = (candidate.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('attach') || aria.includes('voice') || aria.includes('model') || aria.includes('focus') || aria.includes('source') || aria.includes('dictat') || aria.includes('claude')) continue;
      var bg = window.getComputedStyle(candidate).backgroundColor || '';
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        candidate.click();
        return true;
      }
    }
    if (inputEl) {
      inputEl.focus();
      var enterEvt = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true
      });
      inputEl.dispatchEvent(enterEvt);
      return true;
    }
    return false;
  }

  var _isPasting = false;
  var _autoSendLastText = '';
  var _autoSendStableSince = 0;

  function isPerplexityStillGenerating() {
    var stopBtns = Array.from(document.querySelectorAll('button[aria-label*="Stop" i]'));
    for (var i = 0; i < stopBtns.length; i++) {
      var r = stopBtns[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return true;
    }
    return false;
  }

  function stripSourcesFromClone(rootEl) {
    if (!rootEl) return;
    // Remove any heading/paragraph/strong whose text is "Sources" or "Source:" and everything after it
    var allEls = Array.from(rootEl.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li, strong, b'));
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (!el.isConnected && !rootEl.contains(el)) continue;
      var t = (el.innerText || el.textContent || '').trim();
      if (/^(?:sources?|references?)\s*:?$/i.test(t)) {
        var topChild = el;
        while (topChild.parentElement && topChild.parentElement !== rootEl) {
          var parentTxt = (topChild.parentElement.innerText || topChild.parentElement.textContent || '').trim();
          if (/^(?:sources?|references?)\b/i.test(parentTxt)) {
            topChild = topChild.parentElement;
          } else {
            break;
          }
        }
        var cur = topChild;
        while (cur) {
          var nxt = cur.nextSibling;
          cur.remove();
          cur = nxt;
        }
        break;
      }
    }
    // Also check trailing elements/list items for "Sources\n..." or "[lawphil.net]" citation lines at the end
    var children = Array.from(rootEl.children || []);
    for (var c = children.length - 1; c >= Math.max(0, children.length - 3); c--) {
      var child = children[c];
      if (!child) continue;
      var ct = (child.innerText || child.textContent || '').trim();
      if (/^(?:sources?|references?)\b/i.test(ct) || (/\b(?:lawphil\.net|G\.?\s*R\.?\s*No\.)/i.test(ct) && ct.length < 380 && /\[lawphil/i.test(ct))) {
        child.remove();
      } else if (child.tagName === 'UL' || child.tagName === 'OL') {
        var lis = Array.from(child.querySelectorAll('li'));
        if (lis.length > 0) {
          var lastLi = lis[lis.length - 1];
          var liTxt = (lastLi.innerText || lastLi.textContent || '').trim();
          if (/^(?:sources?|references?)\b/i.test(liTxt) || /\[lawphil\.net\]\.?\s*$/i.test(liTxt)) {
            lastLi.remove();
            if (child.querySelectorAll('li').length === 0) child.remove();
          }
        }
      }
    }
  }

  function stripLeadingPreambleFromClone(rootEl) {
    if (!rootEl) return;
    var removePreceding = function(target, keepTarget) {
      if (!target || target === rootEl) return;
      var cur = target;
      while (cur && cur.parentElement && cur !== rootEl) {
        var prev = cur.previousSibling;
        while (prev) {
          var toRem = prev;
          prev = prev.previousSibling;
          toRem.remove();
        }
        cur = cur.parentElement;
      }
      if (!keepTarget) {
        target.remove();
      }
    };

    // 1. If a table exists in the answer, always start directly with the first table
    // (strips introductory commentary, title, and "RECIT READY SUMMARY" above the table)
    var firstTable = rootEl.querySelector('table');
    if (firstTable) {
      removePreceding(firstTable, true);
      return;
    }

    // 2. Fallback if no HTML table exists: strip "RECIT READY SUMMARY" heading and everything above it
    var allEls = Array.from(rootEl.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, li, strong, b'));
    for (var i = 0; i < allEls.length; i++) {
      var el = allEls[i];
      if (!el.isConnected && !rootEl.contains(el)) continue;
      var t = (el.innerText || el.textContent || '').trim();
      if (/^(?:[#*\s\d.()IVX\-–—]+)?recit[\s\-]*ready\s+summary\b\s*:?\s*$/i.test(t)) {
        var block = el.closest('h1, h2, h3, h4, h5, h6, p, li') || el;
        var bTxt = (block.innerText || block.textContent || '').trim();
        if (bTxt.length < 160 && /recit[\s\-]*ready\s+summary/i.test(bTxt)) {
          removePreceding(block, false);
          break;
        }
      }
    }

    // 3. Also strip leading Perplexity meta-introductory paragraph ("I have the full text of the decision...", etc.)
    var topChildren = Array.from(rootEl.children || []);
    for (var c = 0; c < Math.min(topChildren.length, 4); c++) {
      var child = topChildren[c];
      if (!child || (!child.isConnected && !rootEl.contains(child))) continue;
      var ct = (child.innerText || child.textContent || '').trim();
      if (
        ct.length < 650 &&
        /\b(?:full text of the (?:decision|case|ponencia)|from the text you (?:pasted|provided|shared)|complete ponencia|did not pull (?:it |this )?from (?:lawphil|the sc|sc e-?library)|based on the (?:full )?text you (?:pasted|provided)|here is the (?:case )?digest)\b/i.test(ct)
      ) {
        removePreceding(child, false);
      }
    }
  }

  function stripLeadingPreambleTextInStudio(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    var cleaned = rawText.trim();

    var lines = cleaned.split(/\r?\n/);
    for (var i = 0; i < lines.length - 1; i++) {
      var line = lines[i].trim();
      if (line.indexOf('|') !== -1) {
        var nextIdx = i + 1;
        while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
        if (nextIdx < lines.length) {
          var nextLine = lines[nextIdx].trim();
          if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(nextLine) || (line.indexOf('|') === 0 && nextLine.indexOf('|') === 0)) {
            return lines.slice(i).join('\n').trim();
          }
        }
      }
    }

    var recitMatch = cleaned.match(/(?:^|\n)\s*(?:#{1,6}\s*|\*{1,2}\s*|\d+[\.\)]\s*|[IVX]+[\.\)]\s*)*recit[\s\-]*ready\s+summary\b[^\n]*(?:\n+|$)/i);
    if (recitMatch && typeof recitMatch.index === 'number') {
      cleaned = cleaned.slice(recitMatch.index + recitMatch[0].length).trim();
    }

    cleaned = cleaned.replace(
      /^(?:\s*[^\n]*\b(?:full text of the (?:decision|case|ponencia)|from the text you (?:pasted|provided|shared)|complete ponencia|did not pull (?:it |this )?from (?:lawphil|the sc|sc e-?library)|based on the (?:full )?text you (?:pasted|provided)|here is the (?:case )?digest)\b[^\n]*(?:\n+|$))+/i,
      ''
    ).trim();

    return cleaned;
  }

  function stripTrailingSourcesTextInStudio(rawText) {
    if (!rawText || typeof rawText !== 'string') return '';
    var cleaned = rawText.trim();
    cleaned = cleaned.replace(/\n+\s*(?:#{1,6}\s*|\*{1,2}\s*|[•\-*]\s*)?Sources?\s*\*{0,2}\s*:?\s*\n+[\s\S]*$/i, '');
    cleaned = cleaned.replace(/\n+\s*(?:[•\-*]\s*)?[^\n]*\bG\.?\s*R\.?\s*No\.[^\n]*\[lawphil[^\n]*$/i, '');
    cleaned = cleaned.replace(/\n+\s*(?:[•\-*]\s*)?[^\n]*\[lawphil\.net\]\.?\s*$/i, '');
    return cleaned.trim();
  }

  function getLatestAnswerSnapshot() {
    var rawProse = Array.from(document.querySelectorAll('.prose, [class*="prose"], .markdown-body')).filter(function(el) {
      if (el.closest('#la-pplx-studio-bar')) return false;
      if (el.closest('textarea, [contenteditable="true"]')) return false;
      var txt = (el.innerText || '').trim();
      return txt.length > 5;
    });

    // Keep ONLY outermost prose blocks (exclude any child/bullet element that is inside an outer .prose)
    var outerProse = rawProse.filter(function(el) {
      return !rawProse.some(function(other) {
        return other !== el && other.contains(el);
      });
    });

    if (outerProse.length === 0) {
      return { html: '', text: '', wordCount: 0 };
    }

    var lastOuter = outerProse[outerProse.length - 1];
    var turnContainer = lastOuter;
    for (var lvl = 0; lvl < 4; lvl++) {
      var p = turnContainer.parentElement;
      if (!p || p === document.body || p.tagName === 'MAIN') break;
      var copyBtns = p.querySelectorAll('button[aria-label*="Copy" i]');
      if (copyBtns.length > 1) break;
      turnContainer = p;
    }

    var turnBlocks = outerProse.filter(function(el) {
      return turnContainer.contains(el);
    });
    if (turnBlocks.length === 0) turnBlocks = [lastOuter];

    // If any block in this turn contains a table, skip any earlier prose blocks in this turn that preceded the first table block
    var firstTableBlockIdx = turnBlocks.findIndex(function(b) {
      return !!b.querySelector('table');
    });
    if (firstTableBlockIdx > 0) {
      turnBlocks = turnBlocks.slice(firstTableBlockIdx);
    }

    var htmlParts = [];
    var textParts = [];
    turnBlocks.forEach(function(block) {
      var clone = block.cloneNode(true);
      clone.querySelectorAll('button, svg, sup, .citation, [data-testid*="citation"], [class*="citation"]').forEach(function(n) {
        n.remove();
      });
      stripLeadingPreambleFromClone(clone);
      stripSourcesFromClone(clone);
      var h = clone.innerHTML.trim();
      var t = stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(clone.innerText || clone.textContent || ''));
      if (t) {
        htmlParts.push(h);
        textParts.push(t);
      }
    });

    var fullHtml = htmlParts.join('<br>');
    var fullText = stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(textParts.join('\n\n')));
    var words = fullText ? fullText.split(/\s+/).filter(Boolean) : [];
    return {
      html: fullHtml,
      text: fullText,
      wordCount: words.length
    };
  }

  function armAutoSendWatcher() {
    try {
      var baseSnap = getLatestAnswerSnapshot();
      var jid = String(_state.jobId || Date.now());
      if (!_state.jobId) _state.jobId = Number(jid);
      sessionStorage.setItem('la_pplx_awaiting_autosend_job_id', jid);
      sessionStorage.setItem('la_pplx_baseline_text', baseSnap.text || '');
      _autoSendLastText = '';
      _autoSendStableSince = 0;
    } catch (e) {}
  }

  var _awaitingLastChangeAt = 0;
  var _awaitingStoppedAt = 0;
  var _studioBlockerReported = false;
  var _studioMountedAt = Date.now();

  function detectStudioPageBlocker() {
    if (Date.now() - _studioMountedAt < 3500) return false;
    var url = (window.location.href || '').toLowerCase();
    var hasInput = !!findPromptInput();
    if (/\/(auth|login|signin|sign-in)\b/.test(url)) {
      emitStudioStatus('error', 'Sign-in required', 'Sign in to Perplexity inside the Studio window, then click Paste Case.', true);
      return true;
    }
    var bodyTxt = '';
    try {
      bodyTxt = ((document.body && document.body.innerText) || '').slice(0, 2500);
    } catch (e) {}
    if (!hasInput && /\b(sign in|log in|continue with google|continue with email)\b/i.test(bodyTxt)) {
      emitStudioStatus('error', 'Sign-in required', 'Sign in to Perplexity inside the Studio window, then click Paste Case.', true);
      return true;
    }
    if (!hasInput && /\b(something went wrong|rate limit|too many requests|verify you are human)\b/i.test(bodyTxt)) {
      emitStudioStatus('error', 'Perplexity error', 'Perplexity reported an error or verification prompt — check the Studio window.', true);
      return true;
    }
    return false;
  }

  function checkAutoSendProgress() {
    if (_state.autoSendDigest === false) return;
    var awaitingJobId = sessionStorage.getItem('la_pplx_awaiting_autosend_job_id');
    if (!awaitingJobId) {
      _awaitingLastChangeAt = 0;
      _awaitingStoppedAt = 0;
      return;
    }
    if (sessionStorage.getItem('la_pplx_autosent_job_id') === awaitingJobId) {
      sessionStorage.removeItem('la_pplx_awaiting_autosend_job_id');
      _awaitingLastChangeAt = 0;
      _awaitingStoppedAt = 0;
      return;
    }

    if (!_awaitingLastChangeAt) _awaitingLastChangeAt = Date.now();

    var baseline = sessionStorage.getItem('la_pplx_baseline_text') || '';
    var snap = getLatestAnswerSnapshot();
    var generating = isPerplexityStillGenerating();

    // Still waiting for Perplexity to start or reach minimum digest length (~55 words)
    if (!snap.text || snap.text === baseline || snap.wordCount < 55) {
      if (snap.text && snap.text !== baseline && snap.wordCount > 5) {
        if (snap.text !== _autoSendLastText) {
          _awaitingLastChangeAt = Date.now();
          _awaitingStoppedAt = 0;
        }
        showStatus('⏳ Perplexity is writing digest (' + snap.wordCount + ' words)… will auto-send when finished.', '#fbbf24');
        emitStudioStatus('streaming', 'Writing digest (' + snap.wordCount + ' words)', 'Perplexity is writing digest (' + snap.wordCount + ' words)…', false);
      } else if (!generating) {
        if (!_awaitingStoppedAt) _awaitingStoppedAt = Date.now();
        if (Date.now() - _awaitingStoppedAt > 25000 && Date.now() - _awaitingLastChangeAt > 25000) {
          emitStudioStatus('error', 'Generation stalled', 'Perplexity did not start or stalled before completing digest — focus Studio to check.', true);
        }
      } else {
        _awaitingStoppedAt = 0;
      }
      _autoSendLastText = snap.text || '';
      _autoSendStableSince = Date.now();
      return;
    }

    _awaitingStoppedAt = 0;
    if (snap.text !== _autoSendLastText || generating) {
      if (snap.text !== _autoSendLastText) _awaitingLastChangeAt = Date.now();
      _autoSendLastText = snap.text;
      _autoSendStableSince = Date.now();
      showStatus('⏳ Perplexity is writing digest (' + snap.wordCount + ' words)… will auto-send when finished.', '#fbbf24');
      emitStudioStatus('streaming', 'Writing digest (' + snap.wordCount + ' words)', 'Perplexity is writing digest (' + snap.wordCount + ' words)…', false);
      if (Date.now() - _awaitingLastChangeAt > 150000) {
        emitStudioStatus('error', 'Generation stalled', 'Perplexity digest generation appears stalled — focus Studio to check or send manually.', true);
      }
      return;
    }

    if (!_autoSendStableSince) {
      _autoSendStableSince = Date.now();
      return;
    }

    var stableMs = Date.now() - _autoSendStableSince;
    if (stableMs < 4500) {
      var secsLeft = Math.max(1, Math.ceil((4500 - stableMs) / 1000));
      showStatus('⏳ Digest complete (' + snap.wordCount + ' words) — auto-sending to Case Digest in ' + secsLeft + 's…', '#4ade80');
      emitStudioStatus('streaming', 'Finalizing digest (' + snap.wordCount + ' words)', 'Digest complete (' + snap.wordCount + ' words) — sending in ' + secsLeft + 's…', false);
      return;
    }

    // Answer has stabilized for 4.5s and Stop button is gone — auto-send!
    sessionStorage.setItem('la_pplx_autosent_job_id', awaitingJobId);
    sessionStorage.removeItem('la_pplx_awaiting_autosend_job_id');
    _awaitingLastChangeAt = 0;
    _awaitingStoppedAt = 0;
    sendDigestPayload(snap.html, snap.text);
  }

  function pasteAndMaybeSubmit(manualTrigger) {
    if (_isPasting) return;
    var fullText = (_state.fullPromptText || '').trim();
    if (!fullText) {
      showStatus('⚠️ No PDF text loaded yet — click "⚡ Perplexity Digest" in Legal Annotator.', '#f87171');
      emitStudioStatus('error', 'No PDF text', 'No PDF text loaded yet — retry Perplexity Digest from Legal Annotator.', true);
      return;
    }

    var inputEl = findPromptInput();
    if (!inputEl) {
      if (manualTrigger) showStatus('⏳ Waiting for Perplexity prompt box…', '#fbbf24');
      return false;
    }

    _isPasting = true;
    showStatus('🤖 Ensuring Claude Sonnet + 📋 Pasting case…', '#fbbf24');
    emitStudioStatus('extracting', 'Pasting case', 'Selecting Claude Sonnet and pasting case into Perplexity…', false);

    // Also copy to clipboard so manual Ctrl+V always has it
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(fullText).catch(function(){});
      }
    } catch (e) {}

    // Always verify/select Claude 5.5 Sonnet (or latest Claude model) BEFORE pasting and submitting
    ensureClaudeModelSelected(inputEl, function() {
      var activeInput = findPromptInput() || inputEl;
      if (!activeInput || !activeInput.isConnected) {
        _isPasting = false;
        setTimeout(function() { processActiveJob(); }, 400);
        return;
      }

      try {
        realPointerClick(activeInput);
        activeInput.focus();
      } catch (e) {}

      setInputText(activeInput, fullText);

      setTimeout(function() {
        // Verify the input element didn't unmount mid-paste during a Space page transition
        if (!activeInput.isConnected) {
          _isPasting = false;
          setTimeout(function() { processActiveJob(); }, 400);
          return;
        }

        // Mark job as handled ONLY after confirming the paste landed in a live connected Space input
        if (_state.jobId) {
          sessionStorage.setItem('la_pplx_handled_job_id', String(_state.jobId));
        }

        // If Perplexity converted the large paste into a "Pasted text" file chip, activeInput may now be empty.
        // Put the subfolder instruction (or a short digest prompt) in the text box so Submit is enabled!
        var currentVal = (activeInput.value !== undefined ? activeInput.value : activeInput.textContent) || '';
        if (!currentVal.trim()) {
          var shortPrompt = (_state.instructionText || '').trim() || 'Digest this case following the Law project instructions.';
          if (activeInput.tagName === 'TEXTAREA' || activeInput.tagName === 'INPUT') {
            var proto = window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : Object.getPrototypeOf(activeInput);
            var setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
            if (setter) setter.call(activeInput, shortPrompt);
            else activeInput.value = shortPrompt;
            activeInput.dispatchEvent(new Event('input', { bubbles: true }));
          } else {
            activeInput.focus();
            document.execCommand('insertText', false, shortPrompt);
            activeInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }

        setTimeout(function() {
          _isPasting = false;
          armAutoSendWatcher();
          if (_state.autoSubmit) {
            triggerSubmit(activeInput);
            _awaitingLastChangeAt = Date.now();
            _awaitingStoppedAt = 0;
            if (_state.autoSendDigest !== false) {
              showStatus('🚀 Submitted with Claude Sonnet! Waiting 1–2 mins to auto-send to Case Digest…', '#4ade80');
            } else {
              showStatus('🚀 Submitted with Claude Sonnet! Click "Send to Case Digest" when done.', '#4ade80');
            }
            emitStudioStatus('submitted', 'Prompt submitted', 'Submitted with Claude Sonnet — waiting for Perplexity response…', false, true);
          } else {
            showStatus('✅ Pasted with Claude Sonnet! Review prompt and press Enter to submit.', '#4ade80');
            emitStudioStatus('idle', 'Ready in Studio', 'Pasted with Claude Sonnet — press Enter in Studio to submit.', false, true);
          }
        }, 380);
      }, 280);
    }, false);

    return true;
  }

  function extractAndSendDigest() {
    // 1. Check if user highlighted specific text
    var sel = window.getSelection ? window.getSelection() : null;
    if (sel && !sel.isCollapsed && sel.toString().trim().length > 20) {
      var range = sel.getRangeAt(0);
      var div = document.createElement('div');
      div.appendChild(range.cloneContents());
      stripLeadingPreambleFromClone(div);
      stripSourcesFromClone(div);
      sendDigestPayload(div.innerHTML, stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(sel.toString().trim())));
      return;
    }

    // 2. Get full latest assistant answer snapshot
    var snap = getLatestAnswerSnapshot();
    if (snap.text && snap.text.length > 10) {
      sendDigestPayload(snap.html, snap.text);
      return;
    }

    // 3. Fallback: read system clipboard
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(clipText) {
        if (clipText && clipText.trim().length > 10) {
          sendDigestPayload('', stripLeadingPreambleTextInStudio(stripTrailingSourcesTextInStudio(clipText.trim())));
        } else {
          showStatus('⚠️ No Perplexity answer found yet — wait for answer or select text.', '#f87171');
          emitStudioStatus('error', 'No answer found', 'No Perplexity answer found yet — wait for reply or select text in Studio.', true);
        }
      }).catch(function() {
        showStatus('⚠️ No Perplexity answer found on page yet.', '#f87171');
        emitStudioStatus('error', 'No answer found', 'No Perplexity answer found on page yet.', true);
      });
    } else {
      showStatus('⚠️ No Perplexity answer found on page yet.', '#f87171');
      emitStudioStatus('error', 'No answer found', 'No Perplexity answer found on page yet.', true);
    }
  }

  function sendDigestPayload(html, text) {
    showStatus('⏳ Sending to Case Digest tab…', '#fbbf24');
    sendBridgeMsg({
      action: 'send_digest',
      pdfId: _state.pdfId || '',
      pdfName: _state.pdfName || '',
      digestMode: _state.digestMode === 'replace' ? 'replace' : 'append',
      html: html || '',
      text: text || ''
    });
  }

  window.__onPerplexityDigestSentAck = function(ok) {
    if (ok) {
      var modeWord = _state.digestMode === 'replace' ? 'Replaced in' : 'Appended to';
      showStatus('✅ ' + modeWord + ' Case Digest tab! Ready for next case.', '#4ade80');
      emitStudioStatus('done', 'Digest saved', modeWord + ' Case Digest tab!', false, true);
      var sendBtn = document.getElementById('la-pplx-send-btn');
      var fabBtn = document.getElementById('la-pplx-fab-send');
      if (sendBtn) {
        var orig = sendBtn.innerHTML;
        sendBtn.innerHTML = '✅ Sent to Case Digest!';
        setTimeout(function() { sendBtn.innerHTML = orig; }, 2400);
      }
      if (fabBtn) {
        var origFab = fabBtn.innerHTML;
        fabBtn.innerHTML = '<span>✅ Sent to Case Digest!</span>';
        setTimeout(function() { fabBtn.innerHTML = origFab; }, 2400);
      }
      // Automatically return to the "Law" Project homepage after 900ms so the next PDF (or batch item) works on the very first click!
      setTimeout(function() {
        if (!isSpaceOrCollectionUrl(window.location.href)) {
          returnToLawSpaceHome();
        }
      }, 900);
    }
  };

  var _jobTimer = null;
  function processActiveJob() {
    ensureStudioBar();
    if (!_state.jobId || !_state.fullPromptText) return;

    var handledJob = sessionStorage.getItem('la_pplx_handled_job_id');
    if (handledJob === String(_state.jobId)) return;

    var curUrl = window.location.href;
    // Never force-redirect window.location.href in a loop! Only auto-paste when on a Space/Collection page.
    if (!isSpaceOrCollectionUrl(curUrl)) {
      showStatus('👉 Open your "Law" project (or click "Paste Case" anytime to paste here).', '#fbbf24');
      if (!detectStudioPageBlocker()) {
        if (!_state.pinnedProjectUrl) {
          emitStudioStatus('error', 'Law Space not pinned', 'Open your "Law" project in Perplexity Studio and click Pin "Law" Project.', true);
        } else {
          emitStudioStatus('extracting', 'Open Law Space', 'Navigate to your pinned "Law" project or click Paste Case in Studio.', true);
        }
      }
      return;
    }

    if (!_state.pinnedProjectUrl) {
      _state.pinnedProjectUrl = cleanSpaceUrl(curUrl);
      saveStateCache();
      updateBarUI();
    }

    if (_jobTimer) clearInterval(_jobTimer);
    var attempts = 0;
    _jobTimer = setInterval(function() {
      if (Date.now() < _spaceTransitionReadyAt) return;
      attempts++;
      if (sessionStorage.getItem('la_pplx_handled_job_id') === String(_state.jobId)) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        return;
      }
      var inputEl = findPromptInput();
      if (inputEl && inputEl.isConnected) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        setTimeout(function() {
          pasteAndMaybeSubmit(false);
        }, 250);
      } else if (attempts >= 25) {
        clearInterval(_jobTimer);
        _jobTimer = null;
        sessionStorage.setItem('la_pplx_handled_job_id', String(_state.jobId));
        showStatus('Click "Paste Case" above when prompt box is ready.', '#fbbf24');
        if (!detectStudioPageBlocker()) {
          emitStudioStatus('error', 'Prompt box missing', 'Perplexity prompt box not found — focus Studio and click Paste Case.', true);
        }
      }
    }, 350);
  }

  window.__PPLX_STUDIO_RECEIVE_JOB = function(job) {
    if (!job || typeof job !== 'object') return;
    var isNewJob = job.jobId && String(job.jobId) !== String(_state.jobId);
    for (var k in job) {
      if (job[k] !== undefined && job[k] !== null) {
        _state[k] = job[k];
      }
    }
    if (isNewJob) {
      sessionStorage.removeItem('la_pplx_handled_job_id');
      sessionStorage.removeItem('la_pplx_awaiting_autosend_job_id');
      sessionStorage.removeItem('la_pplx_claude_verified_job');
      _isPasting = false;
    }
    saveStateCache();
    ensureStudioBar();

    // When starting a brand-new case from Legal Annotator while the Studio window is sitting on a previous case's thread (/search/...),
    // return once to the "Law" Space page so each case gets its own clean thread in the Law project.
    if (isNewJob && !isSpaceOrCollectionUrl(window.location.href)) {
      if (sessionStorage.getItem('la_pplx_nav_once_job_id') !== String(_state.jobId)) {
        sessionStorage.setItem('la_pplx_nav_once_job_id', String(_state.jobId));
        showStatus('Opening "Law" Project for new case…', '#fbbf24');
        if (returnToLawSpaceHome()) {
          return;
        }
      }
    }

    processActiveJob();
  };

  // Gentle check to keep Studio bar mounted during SPA navigation and watch for Auto-Send completion
  var _lastHref = window.location.href;
  setInterval(function() {
    ensureStudioBar();
    checkAutoSendProgress();
    if (!_studioBlockerReported && !sessionStorage.getItem('la_pplx_handled_job_id')) {
      if (detectStudioPageBlocker()) _studioBlockerReported = true;
    }
    if (window.location.href !== _lastHref) {
      var prevHref = _lastHref;
      _lastHref = window.location.href;
      _studioBlockerReported = false;
      updateBarUI();
      if (isSpaceOrCollectionUrl(_lastHref)) {
        if (!isSpaceOrCollectionUrl(prevHref)) {
          _spaceTransitionReadyAt = Math.max(_spaceTransitionReadyAt, Date.now() + 850);
        }
        processActiveJob();
      }
    }
  }, 800);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
      ensureStudioBar();
      emitStudioStatus('extracting', 'Studio ready', 'Perplexity Studio loaded.', false);
      processActiveJob();
    });
  } else {
    ensureStudioBar();
    emitStudioStatus('extracting', 'Studio ready', 'Perplexity Studio loaded.', false);
    processActiveJob();
  }
})();
"#;

#[tauri::command]
async fn desktop_get_perplexity_prefs() -> Result<serde_json::Value, String> {
    Ok(load_pplx_prefs_disk())
}

#[tauri::command]
async fn desktop_save_perplexity_prefs(prefs: serde_json::Value) -> Result<bool, String> {
    let mut current = load_pplx_prefs_disk();
    if let Some(obj) = prefs.as_object() {
        for (k, v) in obj {
            current[k] = v.clone();
        }
    }
    save_pplx_prefs_disk(&current);
    Ok(true)
}

fn emit_pplx_studio_status(app: &tauri::AppHandle, mut payload: serde_json::Value) {
    if let Some(obj) = payload.as_object_mut() {
        if !obj.contains_key("action") {
            let is_err = obj.get("state").and_then(|v| v.as_str()) == Some("error");
            obj.insert(
                "action".to_string(),
                serde_json::Value::String(
                    if is_err {
                        "studio_error"
                    } else {
                        "studio_status"
                    }
                    .to_string(),
                ),
            );
        }
    }
    if let Some(main_win) = app.get_webview_window("main") {
        if let Ok(json_str) = serde_json::to_string(&payload) {
            let js = format!(
                "(function(p){{ if (typeof window.__desktopForwardPerplexityStatus === 'function') window.__desktopForwardPerplexityStatus(p); else if (typeof window.__onPerplexityStudioStatus === 'function') window.__onPerplexityStudioStatus(p); }})({});",
                json_str
            );
            let _ = main_win.eval(&js);
        }
    }
}

#[tauri::command]
fn desktop_focus_perplexity_studio(app: tauri::AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window("perplexity-studio") {
        if win.is_minimized().unwrap_or(false) {
            let _ = win.unminimize();
        }
        let _ = win.show();
        let _ = win.set_focus();
        Ok(true)
    } else {
        Ok(false)
    }
}

#[tauri::command]
async fn desktop_open_perplexity_studio(
    app: tauri::AppHandle,
    pdf_id: String,
    pdf_name: String,
    subfolder_name: Option<String>,
    instruction_text: Option<String>,
    pdf_text: String,
    full_prompt_text: String,
    pinned_project_url: Option<String>,
    auto_submit: Option<bool>,
    digest_mode: Option<String>,
    auto_send_digest: Option<bool>,
) -> Result<bool, String> {
    let mut disk_prefs = load_pplx_prefs_disk();
    let eff_pinned = pinned_project_url
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            disk_prefs
                .get("pinnedProjectUrl")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or_default();

    let eff_auto_submit = auto_submit.unwrap_or_else(|| {
        disk_prefs
            .get("autoSubmit")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });

    let eff_digest_mode = digest_mode
        .filter(|s| s == "replace" || s == "append")
        .or_else(|| {
            disk_prefs
                .get("digestMode")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "append".to_string());

    let eff_auto_send = auto_send_digest.unwrap_or_else(|| {
        disk_prefs
            .get("autoSendDigest")
            .and_then(|v| v.as_bool())
            .unwrap_or(true)
    });

    disk_prefs["pinnedProjectUrl"] = serde_json::Value::String(eff_pinned.clone());
    disk_prefs["autoSubmit"] = serde_json::Value::Bool(eff_auto_submit);
    disk_prefs["digestMode"] = serde_json::Value::String(eff_digest_mode.clone());
    disk_prefs["autoSendDigest"] = serde_json::Value::Bool(eff_auto_send);
    save_pplx_prefs_disk(&disk_prefs);

    let job_id = now_ms();
    let job_val = serde_json::json!({
        "pdfId": pdf_id,
        "pdfName": pdf_name,
        "subfolderName": subfolder_name.unwrap_or_default(),
        "instructionText": instruction_text.unwrap_or_default(),
        "pdfText": pdf_text,
        "fullPromptText": full_prompt_text,
        "pinnedProjectUrl": eff_pinned,
        "autoSubmit": eff_auto_submit,
        "digestMode": eff_digest_mode,
        "autoSendDigest": eff_auto_send,
        "jobId": job_id,
    });

    let state_arc = get_pplx_job_state();
    if let Ok(mut g) = state_arc.lock() {
        *g = job_val.clone();
    }

    let job_json_str = serde_json::to_string(&job_val).unwrap_or_else(|_| "{}".to_string());
    let win_label = "perplexity-studio";

    if let Some(existing) = app.get_webview_window(win_label) {
        let _ = existing.set_title(&format!(
            "Perplexity 'Law' Digest Studio — {} — Legal Annotator",
            pdf_name
        ));
        if existing.is_minimized().unwrap_or(false) {
            let _ = existing.unminimize();
        }
        let _ = existing.show();
        let _ = existing.set_focus();
        let eval_js = format!(
            "window.__PPLX_STUDIO_RECEIVE_JOB && window.__PPLX_STUDIO_RECEIVE_JOB({});",
            job_json_str
        );
        let _ = existing.eval(&eval_js);
        emit_pplx_studio_status(
            &app,
            serde_json::json!({
                "action": "studio_status",
                "state": "extracting",
                "stepLabel": "Studio focused",
                "message": format!("Opened Perplexity Studio for {}", pdf_name),
                "pdfId": pdf_id,
                "canRetry": false
            }),
        );
        return Ok(true);
    }

    let start_url_str = if eff_pinned.starts_with("https://www.perplexity.ai/spaces/")
        || eff_pinned.starts_with("https://www.perplexity.ai/collections/")
    {
        eff_pinned.clone()
    } else {
        "https://www.perplexity.ai/spaces".to_string()
    };

    let parsed_url = tauri::Url::parse(&start_url_str).map_err(|e| e.to_string())?;
    let app_for_nav = app.clone();
    let state_for_nav = get_pplx_job_state();
    let init_script_with_job = format!(
        "window.__INITIAL_PPLX_JOB__ = {};\n{}",
        job_json_str, PERPLEXITY_INIT_SCRIPT
    );

    let mut builder = WebviewWindowBuilder::new(&app, win_label, WebviewUrl::External(parsed_url))
        .title(format!(
            "Perplexity 'Law' Digest Studio — {} — Legal Annotator",
            pdf_name
        ))
        .inner_size(1120.0, 840.0)
        .center()
        .visible(true)
        .focused(true)
        .initialization_script(&init_script_with_job);

    builder = builder.on_navigation(move |url| {
        let url_str = url.as_str();
        if let Some(idx) = url_str.find("http://127.0.0.1:19876/__pplx_msg?d=") {
            let encoded = &url_str[(idx + "http://127.0.0.1:19876/__pplx_msg?d=".len())..];
            let b64_clean = percent_decode_str(encoded);
            if let Ok(decoded_bytes) = BASE64.decode(b64_clean.as_bytes()) {
                if let Ok(json_str) = String::from_utf8(decoded_bytes) {
                    if let Ok(msg_val) = serde_json::from_str::<serde_json::Value>(&json_str) {
                        let action = msg_val
                            .get("action")
                            .and_then(|a| a.as_str())
                            .unwrap_or("");
                        if action == "save_prefs" {
                            let mut prefs = load_pplx_prefs_disk();
                            if let Some(u) = msg_val.get("pinnedProjectUrl").and_then(|v| v.as_str()) {
                                prefs["pinnedProjectUrl"] = serde_json::Value::String(u.to_string());
                            }
                            if let Some(a) = msg_val.get("autoSubmit").and_then(|v| v.as_bool()) {
                                prefs["autoSubmit"] = serde_json::Value::Bool(a);
                            }
                            if let Some(m) = msg_val.get("digestMode").and_then(|v| v.as_str()) {
                                prefs["digestMode"] = serde_json::Value::String(m.to_string());
                            }
                            if let Some(asend) = msg_val.get("autoSendDigest").and_then(|v| v.as_bool()) {
                                prefs["autoSendDigest"] = serde_json::Value::Bool(asend);
                            }
                            save_pplx_prefs_disk(&prefs);
                            if let Ok(mut st) = state_for_nav.lock() {
                                if let Some(u) = prefs.get("pinnedProjectUrl").and_then(|v| v.as_str()) {
                                    st["pinnedProjectUrl"] = serde_json::Value::String(u.to_string());
                                }
                                if let Some(a) = prefs.get("autoSubmit").and_then(|v| v.as_bool()) {
                                    st["autoSubmit"] = serde_json::Value::Bool(a);
                                }
                                if let Some(m) = prefs.get("digestMode").and_then(|v| v.as_str()) {
                                    st["digestMode"] = serde_json::Value::String(m.to_string());
                                }
                                if let Some(asend) = prefs.get("autoSendDigest").and_then(|v| v.as_bool()) {
                                    st["autoSendDigest"] = serde_json::Value::Bool(asend);
                                }
                            }
                            if let Some(main_win) = app_for_nav.get_webview_window("main") {
                                let js = format!(
                                    "window.__onPerplexityPrefsUpdated && window.__onPerplexityPrefsUpdated({});",
                                    json_str
                                );
                                let _ = main_win.eval(&js);
                            }
                        } else if action == "send_digest" {
                            if let Some(main_win) = app_for_nav.get_webview_window("main") {
                                let js = format!(
                                    "window.__onPerplexityDigestReceived && window.__onPerplexityDigestReceived({});",
                                    json_str
                                );
                                let _ = main_win.eval(&js);
                            }
                            let app_ack = app_for_nav.clone();
                            std::thread::spawn(move || {
                                std::thread::sleep(std::time::Duration::from_millis(60));
                                if let Some(pw) = app_ack.get_webview_window("perplexity-studio") {
                                    let _ = pw.eval("window.__onPerplexityDigestSentAck && window.__onPerplexityDigestSentAck(true);");
                                }
                            });
                        } else if action == "native_click" {
                            let css_x = msg_val.get("x").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let css_y = msg_val.get("y").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let js_dpr = msg_val.get("dpr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let app_click = app_for_nav.clone();
                            std::thread::spawn(move || {
                                if let Some(pw) = app_click.get_webview_window("perplexity-studio") {
                                    let _ = pw.show();
                                    let _ = pw.unminimize();
                                    let _ = pw.set_focus();
                                    if let Ok(inner_pos) = pw.inner_position() {
                                        let win_scale = pw.scale_factor().unwrap_or(1.0);
                                        let scale = if js_dpr > 0.2 { js_dpr } else { win_scale };
                                        let screen_x = inner_pos.x + (css_x * scale).round() as i32;
                                        let screen_y = inner_pos.y + (css_y * scale).round() as i32;
                                        perform_native_os_mouse_click(screen_x, screen_y);
                                    }
                                }
                            });
                        } else if action == "studio_status" || action == "studio_error" {
                            let mut status_val = msg_val.clone();
                            if let Some(obj) = status_val.as_object_mut() {
                                if !obj.contains_key("pdfId") {
                                    if let Ok(st) = state_for_nav.lock() {
                                        if let Some(pid) = st.get("pdfId").cloned() {
                                            obj.insert("pdfId".to_string(), pid);
                                        }
                                    }
                                }
                                if action == "studio_error" && !obj.contains_key("state") {
                                    obj.insert(
                                        "state".to_string(),
                                        serde_json::Value::String("error".to_string()),
                                    );
                                }
                            }
                            emit_pplx_studio_status(&app_for_nav, status_val);
                        }
                    }
                }
            }
            return false;
        }
        true
    });

    let win = match builder.build() {
        Ok(w) => w,
        Err(e) => {
            let err_msg = e.to_string();
            emit_pplx_studio_status(
                &app,
                serde_json::json!({
                    "action": "studio_error",
                    "state": "error",
                    "stepLabel": "Studio failed to open",
                    "message": format!("Could not open Perplexity Studio: {}", err_msg),
                    "pdfId": pdf_id,
                    "canRetry": true
                }),
            );
            return Err(err_msg);
        }
    };
    let _ = win.show();
    let _ = win.unminimize();
    let _ = win.set_focus();
    emit_pplx_studio_status(
        &app,
        serde_json::json!({
            "action": "studio_status",
            "state": "extracting",
            "stepLabel": "Studio opened",
            "message": format!("Opening Perplexity Studio for {}", pdf_name),
            "pdfId": pdf_id,
            "canRetry": false
        }),
    );
    let app_for_close = app.clone();
    let state_for_close = get_pplx_job_state();
    win.on_window_event(move |event| {
        if let tauri::WindowEvent::Destroyed = event {
            let cur_pdf_id = state_for_close
                .lock()
                .ok()
                .and_then(|st| {
                    st.get("pdfId")
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .unwrap_or_default();
            emit_pplx_studio_status(
                &app_for_close,
                serde_json::json!({
                    "action": "studio_status",
                    "state": "idle",
                    "stepLabel": "Studio closed",
                    "message": "Perplexity Studio window was closed.",
                    "pdfId": cur_pdf_id,
                    "canRetry": false
                }),
            );
        }
    });
    Ok(true)
}

#[cfg(target_os = "windows")]
pub(crate) fn perform_native_os_mouse_click(screen_x: i32, screen_y: i32) {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(lp_point: *mut Point) -> i32;
        fn SetCursorPos(x: i32, y: i32) -> i32;
        fn mouse_event(dw_flags: u32, dx: u32, dy: u32, dw_data: u32, dw_extra_info: usize);
    }
    const MOUSEEVENTF_LEFTDOWN: u32 = 0x0002;
    const MOUSEEVENTF_LEFTUP: u32 = 0x0004;
    unsafe {
        let mut start = Point {
            x: screen_x,
            y: screen_y,
        };
        let _ = GetCursorPos(&mut start);
        let steps = 5;
        for i in 1..=steps {
            let nx = start.x + ((screen_x - start.x) * i) / steps;
            let ny = start.y + ((screen_y - start.y) * i) / steps;
            SetCursorPos(nx, ny);
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        SetCursorPos(screen_x, screen_y);
        std::thread::sleep(std::time::Duration::from_millis(35));
        mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, 0);
        std::thread::sleep(std::time::Duration::from_millis(25));
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
    }
}

#[cfg(not(target_os = "windows"))]
pub(crate) fn perform_native_os_mouse_click(_screen_x: i32, _screen_y: i32) {}

pub(crate) fn percent_decode_str(input: &str) -> String {
    let bytes = input.as_bytes();
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

pub(crate) fn sanitize_cache_id(file_id: &str) -> String {
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

/// Delete one cached PDF from the on-disk offline cache (used by
/// "Remove Offline Copy"). Missing files are not an error.
#[tauri::command]
async fn desktop_cache_delete_pdf(
    state: tauri::State<'_, AppState>,
    file_id: String,
) -> Result<bool, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Ok(false);
    }
    let path = state.pdf_cache_dir.join(format!("{}.pdf", safe_id));
    if !path.exists() {
        return Ok(false);
    }
    Ok(fs::remove_file(&path).is_ok())
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
    fallback_token: Option<String>,
) -> Result<serde_json::Value, String> {
    let safe_id = sanitize_cache_id(&file_id);
    if safe_id.is_empty() {
        return Ok(serde_json::json!({
            "ok": false,
            "error": "Invalid Google Drive file ID",
            "diagnostics": ["Invalid or empty Google Drive File ID"]
        }));
    }

    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let mut diag: Vec<String> = Vec::new();
    diag.push(format!("Target File ID: {}", safe_id));

    let mut tokens_to_try: Vec<(&str, String)> = Vec::new();
    if let Some(t) = token {
        let trimmed = t.trim().to_string();
        if !trimmed.is_empty() {
            tokens_to_try.push(("Syllabus Gmail Token", trimmed));
        }
    }
    if let Some(ft) = fallback_token {
        let trimmed = ft.trim().to_string();
        if !trimmed.is_empty() && !tokens_to_try.iter().any(|(_, existing)| existing == &trimmed) {
            tokens_to_try.push(("Main App Drive Token", trimmed));
        }
    }

    if tokens_to_try.is_empty() {
        diag.push("No Google OAuth token provided — skipping authenticated Drive API.".into());
    }

    // 1. Try Google Drive API with provided OAuth token(s)
    for (label, tok) in &tokens_to_try {
        let auth_hdr = format!("Authorization: Bearer {}", tok);
        let mut target_id = safe_id.clone();
        let mut mime_type = String::new();

        // 1a. Check file metadata (resolves shortcuts & detects Google Docs)
        let meta_url = format!(
            "https://www.googleapis.com/drive/v3/files/{}?fields=id,name,mimeType,shortcutDetails&supportsAllDrives=true",
            target_id
        );
        let mut meta_cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
        meta_cmd.args(["-L", "--silent", "--max-time", "25", "-H", &auth_hdr, &meta_url]);
        #[cfg(target_os = "windows")]
        meta_cmd.creation_flags(0x08000000);

        if let Ok(meta_out) = meta_cmd.output() {
            if let Ok(meta_json) = serde_json::from_slice::<serde_json::Value>(&meta_out.stdout) {
                if let Some(err_obj) = meta_json.get("error") {
                    let code = err_obj.get("code").and_then(|c| c.as_u64()).unwrap_or(0);
                    let msg = err_obj
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("Unknown API error");
                    diag.push(format!(
                        "{}: Metadata check returned HTTP {} — {} (If 404/403 on a restricted file, sign in with the specific Gmail that has access or grant drive.readonly permission)",
                        label, code, msg
                    ));
                } else {
                    mime_type = meta_json
                        .get("mimeType")
                        .and_then(|m| m.as_str())
                        .unwrap_or("")
                        .to_string();
                    let fname = meta_json.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    diag.push(format!(
                        "{}: Metadata OK — name=\"{}\", mimeType=\"{}\"",
                        label, fname, mime_type
                    ));
                    if mime_type == "application/vnd.google-apps.shortcut" {
                        if let Some(tid) = meta_json
                            .get("shortcutDetails")
                            .and_then(|s| s.get("targetId"))
                            .and_then(|t| t.as_str())
                        {
                            target_id = sanitize_cache_id(tid);
                            diag.push(format!("{}: Followed Drive shortcut to targetId={}", label, target_id));
                        }
                    }
                }
            }
        }

        // 1b. If Google Doc, export as PDF; otherwise download via alt=media
        let dl_url = if mime_type == "application/vnd.google-apps.document" {
            format!(
                "https://www.googleapis.com/drive/v3/files/{}/export?mimeType=application/pdf",
                target_id
            )
        } else {
            format!(
                "https://www.googleapis.com/drive/v3/files/{}?alt=media&supportsAllDrives=true",
                target_id
            )
        };

        let mut cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
        cmd.args(["-L", "--silent", "--max-time", "90", "-H", &auth_hdr, &dl_url]);
        #[cfg(target_os = "windows")]
        cmd.creation_flags(0x08000000);

        if let Ok(out) = cmd.output() {
            if out.stdout.len() > 100 && &out.stdout[0..4] == b"%PDF" {
                diag.push(format!("{}: Downloaded valid PDF ({} bytes)", label, out.stdout.len()));
                let cache_dir = resolve_data_dir().join("pdf_cache");
                let _ = fs::create_dir_all(&cache_dir);
                let _ = fs::write(cache_dir.join(format!("{}.pdf", safe_id)), &out.stdout);
                return Ok(serde_json::json!({
                    "ok": true,
                    "base64": BASE64.encode(&out.stdout),
                    "diagnostics": diag
                }));
            } else if out.stdout.len() >= 4 && &out.stdout[0..4] == b"PK\x03\x04" {
                diag.push(format!(
                    "{}: Downloaded file is a ZIP/DOCX archive (PK header), not a PDF. Trying Google Docs PDF export…",
                    label
                ));
                let exp_url = format!(
                    "https://www.googleapis.com/drive/v3/files/{}/export?mimeType=application/pdf",
                    target_id
                );
                let mut exp_cmd = std::process::Command::new(r"C:\Windows\System32\curl.exe");
                exp_cmd.args(["-L", "--silent", "--max-time", "90", "-H", &auth_hdr, &exp_url]);
                #[cfg(target_os = "windows")]
                exp_cmd.creation_flags(0x08000000);
                if let Ok(exp_out) = exp_cmd.output() {
                    if exp_out.stdout.len() > 100 && &exp_out.stdout[0..4] == b"%PDF" {
                        let cache_dir = resolve_data_dir().join("pdf_cache");
                        let _ = fs::create_dir_all(&cache_dir);
                        let _ = fs::write(cache_dir.join(format!("{}.pdf", safe_id)), &exp_out.stdout);
                        return Ok(serde_json::json!({
                            "ok": true,
                            "base64": BASE64.encode(&exp_out.stdout),
                            "diagnostics": diag
                        }));
                    }
                }
            } else if let Ok(err_json) = serde_json::from_slice::<serde_json::Value>(&out.stdout) {
                let code = err_json
                    .get("error")
                    .and_then(|e| e.get("code"))
                    .and_then(|c| c.as_u64())
                    .unwrap_or(0);
                let msg = err_json
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .unwrap_or("Unknown error");
                diag.push(format!("{}: Download returned HTTP {} — {}", label, code, msg));
            }
        }
    }

    // 2. Fallback: Direct public/shared link download
    let public_urls = [
        (
            "Public Drive Download",
            format!(
                "https://drive.usercontent.google.com/download?id={}&export=download&confirm=t",
                safe_id
            ),
        ),
        (
            "Public Google Doc Export",
            format!("https://docs.google.com/document/d/{}/export?format=pdf", safe_id),
        ),
    ];

    for (label, url) in &public_urls {
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
                diag.push(format!("{}: Succeeded ({} bytes)", label, out.stdout.len()));
                let cache_dir = resolve_data_dir().join("pdf_cache");
                let _ = fs::create_dir_all(&cache_dir);
                let _ = fs::write(cache_dir.join(format!("{}.pdf", safe_id)), &out.stdout);
                return Ok(serde_json::json!({
                    "ok": true,
                    "base64": BASE64.encode(&out.stdout),
                    "diagnostics": diag
                }));
            } else {
                let preview = String::from_utf8_lossy(&out.stdout[..std::cmp::min(out.stdout.len(), 600)]);
                if preview.contains("ServiceLogin") || preview.contains("accounts.google.com") {
                    diag.push(format!(
                        "{}: Redirected to Google Sign-In page — file is RESTRICTED to specific email accounts.",
                        label
                    ));
                } else if out.stdout.len() >= 4 && &out.stdout[0..4] == b"PK\x03\x04" {
                    diag.push(format!("{}: File is a Word .docx / ZIP file, not a PDF.", label));
                } else {
                    diag.push(format!(
                        "{}: Returned non-PDF response ({} bytes).",
                        label,
                        out.stdout.len()
                    ));
                }
            }
        }
    }

    let summary_err = if diag.iter().any(|d| d.contains("RESTRICTED") || d.contains("HTTP 404") || d.contains("HTTP 403")) {
        "File is restricted — click '🔑 Sign in Gmail for Restricted Links' at the top of the modal and sign in with the email account that has access.".to_string()
    } else {
        "Could not download PDF from Google Drive.".to_string()
    };

    Ok(serde_json::json!({
        "ok": false,
        "error": summary_err,
        "diagnostics": diag
    }))
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
const UPDATE_REPO: &str = "larxe1/Legal-Annotator-App";
const UPDATE_BRANCH: &str = "main";
const UPDATE_USER_AGENT: &str = "LegalAnnotatorDesktop-Updater";

/// Runs Windows' built-in curl.exe silently (CREATE_NO_WINDOW — never shows a console).
fn run_curl(args: &[&str]) -> Result<std::process::Output, String> {
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;

    let curl = if cfg!(target_os = "windows") {
        let sys_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".to_string());
        let p = PathBuf::from(sys_root).join("System32").join("curl.exe");
        if p.exists() {
            p
        } else {
            PathBuf::from("curl.exe")
        }
    } else {
        PathBuf::from("curl")
    };
    let mut cmd = std::process::Command::new(&curl);
    cmd.args(["-A", UPDATE_USER_AGENT]);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    cmd.output()
        .map_err(|e| format!("could not start the downloader (curl.exe): {e}"))
}

fn curl_err(output: &std::process::Output) -> String {
    let s = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if s.is_empty() {
        format!("downloader exit code {:?}", output.status.code())
    } else {
        s
    }
}

fn parse_version_json(s: &str) -> Option<serde_json::Value> {
    serde_json::from_str(s.trim_start_matches('\u{feff}')).ok()
}

/// SHA of the newest commit on the release branch. Downloading files pinned to this
/// exact commit means GitHub's CDN can never hand us a stale (older) copy.
fn latest_release_sha() -> Option<String> {
    let url = format!("https://api.github.com/repos/{UPDATE_REPO}/commits/{UPDATE_BRANCH}");
    let out = run_curl(&[
        "-fsSL",
        "--max-time",
        "10",
        "-H",
        "Accept: application/vnd.github.sha",
        &url,
    ])
    .ok()?;
    if !out.status.success() {
        return None;
    }
    let sha = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(sha)
    } else {
        None
    }
}

/// All numbers N found as `"build": N` inside a binary (the exe embeds its version.json).
fn embedded_build_numbers(bytes: &[u8]) -> Vec<u64> {
    let needle: &[u8] = b"\"build\"";
    let is_ws = |b: u8| b == b' ' || b == b'\t' || b == b'\r' || b == b'\n';
    let mut out = Vec::new();
    let mut i = 0;
    while i + needle.len() < bytes.len() {
        if bytes[i] != b'"' || &bytes[i..i + needle.len()] != needle {
            i += 1;
            continue;
        }
        let mut j = i + needle.len();
        while j < bytes.len() && is_ws(bytes[j]) {
            j += 1;
        }
        if j < bytes.len() && bytes[j] == b':' {
            j += 1;
            while j < bytes.len() && is_ws(bytes[j]) {
                j += 1;
            }
            let start = j;
            while j < bytes.len() && bytes[j].is_ascii_digit() && j - start < 9 {
                j += 1;
            }
            if j > start {
                if let Ok(n) = std::str::from_utf8(&bytes[start..j]).unwrap_or("").parse::<u64>() {
                    out.push(n);
                }
            }
        }
        i = j.max(i + 1);
    }
    out
}

#[tauri::command]
async fn desktop_check_github_update() -> Result<serde_json::Value, String> {
    let local_val = parse_version_json(EMBEDDED_VERSION_JSON).unwrap_or_else(|| serde_json::json!({}));
    let local_build = local_val.get("build").and_then(|v| v.as_u64()).unwrap_or(1);
    let local_version = local_val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();

    let mut remote: Option<serde_json::Value> = None;
    let mut download_url = String::new();
    let mut last_err = String::new();

    // 1) Preferred: files pinned to the exact newest commit (never stale).
    if let Some(sha) = latest_release_sha() {
        let url = format!("https://raw.githubusercontent.com/{UPDATE_REPO}/{sha}/version.json");
        match run_curl(&["-fsSL", "--max-time", "15", "--retry", "2", &url]) {
            Ok(out) if out.status.success() => {
                if let Some(v) = parse_version_json(&String::from_utf8_lossy(&out.stdout)) {
                    remote = Some(v);
                    download_url = format!(
                        "https://raw.githubusercontent.com/{UPDATE_REPO}/{sha}/Legal%20Annotator.exe"
                    );
                }
            }
            Ok(out) => last_err = curl_err(&out),
            Err(e) => last_err = e,
        }
    }

    // 2) Fallback: branch URL (can lag a few minutes behind right after publishing).
    if remote.is_none() {
        let url = format!(
            "https://raw.githubusercontent.com/{UPDATE_REPO}/{UPDATE_BRANCH}/version.json?t={}",
            now_ms()
        );
        match run_curl(&[
            "-fsSL",
            "--max-time",
            "15",
            "--retry",
            "2",
            "-H",
            "Cache-Control: no-cache",
            "-H",
            "Pragma: no-cache",
            &url,
        ]) {
            Ok(out) if out.status.success() => {
                match parse_version_json(&String::from_utf8_lossy(&out.stdout)) {
                    Some(v) => remote = Some(v),
                    None => last_err = "GitHub returned an unreadable version.json".to_string(),
                }
            }
            Ok(out) => last_err = curl_err(&out),
            Err(e) => last_err = e,
        }
    }

    let Some(remote_val) = remote else {
        return Ok(serde_json::json!({
            "hasUpdate": false,
            "localBuild": local_build,
            "localVersion": local_version,
            "error": if last_err.is_empty() { "Could not reach GitHub".to_string() } else { last_err }
        }));
    };

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
    if download_url.is_empty() {
        download_url = remote_val
            .get("downloadUrl")
            .and_then(|v| v.as_str())
            .unwrap_or("https://github.com/larxe1/Legal-Annotator-App/raw/main/Legal%20Annotator.exe")
            .to_string();
    }

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
async fn desktop_apply_github_update(
    download_url: Option<String>,
    expected_build: Option<u64>,
) -> Result<String, String> {
    let mut url = download_url
        .filter(|u| !u.trim().is_empty())
        .unwrap_or_else(|| {
            format!("https://raw.githubusercontent.com/{UPDATE_REPO}/{UPDATE_BRANCH}/Legal%20Annotator.exe")
        });
    // Branch URLs may be cached by GitHub's CDN — bust the cache (commit-pinned URLs are immutable).
    if url.contains(&format!("/{UPDATE_BRANCH}/")) && !url.contains('?') {
        url = format!("{url}?t={}", now_ms());
    }

    let current_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = current_exe
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Could not find the app's folder.".to_string())?;
    let new_exe = current_exe.with_extension("new.exe");
    let _ = fs::remove_file(&new_exe);

    // Make sure Windows lets us write next to the app before downloading ~33 MB.
    let probe = exe_dir.join(".la_update_probe");
    if fs::write(&probe, b"ok").is_err() {
        return Err(format!(
            "Windows won't let the app save files in its folder ({}). Move the Legal Annotator folder to Documents or Desktop, then try again.",
            exe_dir.display()
        ));
    }
    let _ = fs::remove_file(&probe);

    let new_exe_str = new_exe.to_string_lossy().to_string();
    let output = run_curl(&[
        "-L",
        "--fail",
        "--silent",
        "--show-error",
        "--retry",
        "3",
        "--retry-delay",
        "2",
        "--connect-timeout",
        "20",
        "--max-time",
        "600",
        "-H",
        "Cache-Control: no-cache",
        "-H",
        "Pragma: no-cache",
        "-o",
        &new_exe_str,
        &url,
    ])
    .map_err(|e| format!("Failed to start download: {e}"))?;
    if !output.status.success() {
        let _ = fs::remove_file(&new_exe);
        return Err(format!(
            "Download failed (check your internet connection): {}",
            curl_err(&output)
        ));
    }

    // Verify downloaded file is a valid Windows PE binary (> 10 MB and starts with 'MZ')
    let bytes = fs::read(&new_exe).map_err(|e| format!("Missing downloaded file: {e}"))?;
    if bytes.len() < 10_000_000 {
        let _ = fs::remove_file(&new_exe);
        return Err(format!(
            "Downloaded file is too small ({} bytes), aborting update for safety.",
            bytes.len()
        ));
    }
    if &bytes[0..2] != b"MZ" {
        let _ = fs::remove_file(&new_exe);
        return Err("Downloaded file is not a valid Windows executable.".to_string());
    }
    // Make sure GitHub actually gave us the NEW build (not a cached older copy), otherwise
    // the app would "update" to the same version and try again in a loop.
    if let Some(expected) = expected_build {
        let found = embedded_build_numbers(&bytes);
        if !found.is_empty() && !found.contains(&expected) {
            let _ = fs::remove_file(&new_exe);
            return Err(format!(
                "GitHub is still serving the previous version (build {}) instead of build {expected}. Please try again in a few minutes.",
                found.iter().max().copied().unwrap_or(0)
            ));
        }
    }
    drop(bytes);

    // Swap executable in-place on Windows: rename running .exe -> .old.exe, then .new.exe -> .exe
    // (Windows allows renaming a running .exe, but not overwriting it.)
    let mut old_exe = current_exe.with_extension("old.exe");
    if old_exe.exists() && fs::remove_file(&old_exe).is_err() {
        // A previous leftover is still locked — use a unique name instead of failing.
        old_exe = current_exe.with_extension(format!("old-{}.exe", now_ms()));
    }
    if let Err(rename_err) = fs::rename(&current_exe, &old_exe) {
        let _ = fs::remove_file(&new_exe);
        return Err(format!(
            "Could not replace the app file ({rename_err}). Close any other open Legal Annotator windows and try again."
        ));
    }
    if let Err(swap_err) = fs::rename(&new_exe, &current_exe) {
        // Rollback if swap failed
        let _ = fs::rename(&old_exe, &current_exe);
        return Err(format!("Could not activate new executable: {swap_err}"));
    }

    // Start the updated app (it waits for this process to fully exit first), then exit.
    let pid = std::process::id();
    let launch_exe = current_exe.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(400));
        let started = std::process::Command::new(&launch_exe)
            .arg("--wait-pid")
            .arg(pid.to_string())
            .current_dir(&exe_dir)
            .spawn()
            .is_ok()
            || std::process::Command::new(&launch_exe)
                .current_dir(&exe_dir)
                .spawn()
                .is_ok();
        // If the new copy could not be started, keep this window open; the update is
        // already installed and will be used the next time the app is opened.
        if started {
            std::process::exit(0);
        }
    });

    Ok("Update installed! Restarting Legal Annotator…".to_string())
}

/// After a self-update the new copy is started with `--wait-pid <old pid>`; wait (max 15 s)
/// for the old copy to fully close so both never run at the same time.
fn wait_for_previous_instance_exit() {
    let args: Vec<String> = std::env::args().collect();
    let Some(pos) = args.iter().position(|a| a == "--wait-pid") else {
        return;
    };
    let Some(pid) = args.get(pos + 1).and_then(|s| s.parse::<u32>().ok()) else {
        return;
    };
    #[cfg(target_os = "windows")]
    {
        #[link(name = "kernel32")]
        extern "system" {
            fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> *mut c_void;
            fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
            fn CloseHandle(handle: *mut c_void) -> i32;
        }
        const SYNCHRONIZE: u32 = 0x0010_0000;
        unsafe {
            let handle = OpenProcess(SYNCHRONIZE, 0, pid);
            if !handle.is_null() {
                WaitForSingleObject(handle, 15_000);
                CloseHandle(handle);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = pid;
        std::thread::sleep(std::time::Duration::from_millis(800));
    }
}

/// Removes leftover "<app>.old.exe" / "<app>.old-<n>.exe" files from previous self-updates.
fn cleanup_old_update_files() {
    let Ok(cur_exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = cur_exe.parent().map(|p| p.to_path_buf()) else {
        return;
    };
    let stem = cur_exe
        .file_stem()
        .map(|s| s.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if stem.is_empty() {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        let prefix = format!("{stem}.old");
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.starts_with(&prefix) && name.ends_with(".exe") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    });
}


fn purge_stale_webview_service_worker() {
    if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
        let sw_dir = std::path::PathBuf::from(local_app_data)
            .join("com.legalannotator.desktop")
            .join("EBWebView")
            .join("Default")
            .join("Service Worker");
        if sw_dir.exists() {
            let _ = fs::remove_dir_all(&sw_dir);
        }
    }
}

fn main() {
    // If we were just started by the self-updater, let the old copy close first.
    wait_for_previous_instance_exit();
    // Clean up any leftover .old.exe from a previous self-update
    cleanup_old_update_files();
    // Purge any stale/poisoned Chromium Service Worker cache in WebView2 profile
    purge_stale_webview_service_worker();

    let data_dir = resolve_data_dir();
    let sqlite_path = data_dir.join("notes_mirror.sqlite");
    let pdf_cache_dir = data_dir.join("pdf_cache");
    let page_vault_dir = data_dir.join("page_vault");
    let oauth_path = data_dir.join("google_oauth.json");
    let syllabus_oauth_path = data_dir.join("syllabus_oauth.json");
    let _ = fs::create_dir_all(&pdf_cache_dir);
    let _ = fs::create_dir_all(&page_vault_dir);
    let _ = init_sqlite_mirror(&sqlite_path);

    let initial_tok = load_saved_oauth_token(&oauth_path);
    let initial_status = if initial_tok.is_some() {
        "success".to_string()
    } else {
        "idle".to_string()
    };

    let initial_syl_tok = load_saved_oauth_token(&syllabus_oauth_path);
    let initial_syl_status = if initial_syl_tok.is_some() {
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
        syllabus_oauth_path,
        syllabus_oauth_token: Arc::new(Mutex::new(initial_syl_tok)),
        syllabus_oauth_status: Arc::new(Mutex::new(initial_syl_status)),
    };

    tauri::Builder::default()
        .manage(app_state)
        .setup(|app| {
            if ocr_studio::is_ocr_studio_process() {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("Legal OCR & Compressor Studio — Linked with Legal Annotator");
                }
            } else if print_studio::is_print_studio_process() {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_title("Legal Print Studio — Notes & Case Digests");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            desktop_system_status,
            pdfium_open_path,
            pdfium_open_bytes,
            pdfium_render_page,
            desktop_ocr_page,
            desktop_ocr_png,
            desktop_save_searchable_pdf,
            ocr_studio::desktop_get_studio_mode,
            ocr_studio::desktop_launch_ocr_studio,
            ocr_studio::desktop_pick_pdf_path_only,
            ocr_studio::desktop_start_ocr_compress_job,
            ocr_studio::desktop_get_ocr_compress_status,
            ocr_studio::desktop_cancel_ocr_compress_job,
            ocr_studio::desktop_export_compressed_pdf_as,
            ocr_studio::desktop_split_pdf_to_folder,
            ocr_studio::desktop_get_pdf_ocr_summary,
            ocr_studio::desktop_close_studio_window,
            ocr_studio::desktop_cache_write_chunk,
            print_studio::desktop_get_print_studio_mode,
            print_studio::desktop_save_print_job,
            print_studio::desktop_load_print_job,
            print_studio::desktop_open_print_studio,
            print_studio::desktop_launch_print_studio_process,
            print_studio::desktop_close_print_studio,
            pdfium_pick_local_pdf,
            desktop_start_google_oauth,
            desktop_poll_google_oauth,
            desktop_clear_google_oauth,
            desktop_open_url,
            desktop_get_perplexity_prefs,
            desktop_save_perplexity_prefs,
            desktop_open_perplexity_studio,
            desktop_focus_perplexity_studio,
            gemini_studio::desktop_get_gemini_prefs,
            gemini_studio::desktop_save_gemini_prefs,
            gemini_studio::desktop_open_gemini_studio,
            gemini_studio::desktop_focus_gemini_studio,
            desktop_cache_get_path,
            desktop_cache_save_pdf,
            desktop_cache_read_pdf,
            desktop_cache_delete_pdf,
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
