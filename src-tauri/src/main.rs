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

fn find_pdfium_dll() -> Option<PathBuf> {
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
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("src-tauri").join("bin").join("pdfium.dll"));
        candidates.push(cwd.join("bin").join("pdfium.dll"));
        candidates.push(cwd.join("pdfium.dll"));
    }
    candidates.push(PathBuf::from(r"D:\Code\legal-annotator-desktop\src-tauri\bin\pdfium.dll"));
    candidates.into_iter().find(|p| p.exists())
}

impl PdfiumHolder {
    fn new() -> Self {
        let mut lib_opt = None;
        if let Some(dll_path) = find_pdfium_dll() {
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
            sha256_html TEXT NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;

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
    let mut guard = state.pdfium.lock().map_err(|e| e.to_string())?;
    guard.render_page_png_data_url(&doc_id, page_num, width_px, height_px)
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
    window.location.replace('http://127.0.0.1:19876/__tauri_oauth?token=' + encodeURIComponent(tok));
  }
  function inspectPayload(val) {
    try {
      var s = typeof val === 'string' ? val : JSON.stringify(val);
      if (!s) return false;
      var m = s.match(/ya29\.[A-Za-z0-9_\-\.]+/);
      if (m && m[0] && m[0].length > 20) {
        reportToken(m[0]);
        return true;
      }
    } catch (e) {}
    return false;
  }
  var fakeOpener = {
    postMessage: function(msg, origin) {
      inspectPayload(msg);
    },
    closed: false,
    location: { href: 'https://notetaking-app.pages.dev/' }
  };
  try {
    fakeOpener.frames = new Proxy({}, {
      get: function() { return fakeOpener; }
    });
  } catch (e) {}
  try {
    Object.defineProperty(window, 'opener', {
      get: function() { return fakeOpener; },
      configurable: true
    });
  } catch (e) {}
  window.close = function() {
    try {
      inspectPayload(window.location.href);
      if (document.documentElement) {
        inspectPayload(document.documentElement.innerHTML);
      }
    } catch (e) {}
  };
  setInterval(function() {
    try {
      inspectPayload(window.location.href);
      if (document.documentElement) {
        inspectPayload(document.documentElement.innerHTML);
      }
    } catch (e) {}
  }, 150);
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
        let _ = existing.close();
    }

    let auth_url_str = "https://accounts.google.com/o/oauth2/v2/auth?gsiwebsdk=3&client_id=572567924584-qj0m9fkkkjsrgva6dj32or7esbgkqvql.apps.googleusercontent.com&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file%20email%20profile&redirect_uri=storagerelay%3A%2F%2Fhttps%2Fnotetaking-app.pages.dev%3Fid%3Dauth123456&prompt=select_account&response_type=token&include_granted_scopes=true";
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

fn main() {
    let sqlite_path = PathBuf::from(r"D:\Code\legal-annotator-desktop\data\notes_mirror.sqlite");
    let pdf_cache_dir = PathBuf::from(r"D:\Code\legal-annotator-desktop\data\pdf_cache");
    let oauth_path = PathBuf::from(r"D:\Code\legal-annotator-desktop\data\google_oauth.json");
    let _ = fs::create_dir_all(&pdf_cache_dir);
    let _ = init_sqlite_mirror(&sqlite_path);

    let initial_tok = load_saved_oauth_token(&oauth_path);
    let initial_status = if initial_tok.is_some() {
        "success".to_string()
    } else {
        "idle".to_string()
    };

    let app_state = AppState {
        pdfium: Mutex::new(PdfiumHolder::new()),
        sqlite_path,
        pdf_cache_dir,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Legal Annotator Desktop");
}
