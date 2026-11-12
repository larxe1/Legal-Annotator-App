// ═════════════════════════════════════════════════════════════════════════════
// LEGAL PRINT STUDIO — Native Tauri Window & Job Manifest Persistence
// - Standalone process detection (`--print-studio` or sibling `Legal Print Studio.exe`)
// - Path-safe print job persistence (`<data_dir>/print_jobs/<safe_id>.json`)
// - Reuses/focuses internal `"print-studio"` WebviewWindow (`WebviewUrl::App`)
// ═════════════════════════════════════════════════════════════════════════════

use crate::resolve_data_dir;
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PRINT_STUDIO_TITLE: &str = "Legal Print Studio — Notes & Case Digests";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrintStudioModeInfo {
    pub is_print_studio: bool,
    pub job_id: Option<String>,
    pub doc_id: Option<String>,
    pub folder_id: Option<String>,
}

pub fn is_print_studio_process() -> bool {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--print-studio") {
        return true;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(stem) = exe.file_stem() {
            let s = stem.to_string_lossy().to_lowercase();
            if s.contains("print") && s.contains("studio") {
                return true;
            }
        }
    }
    false
}

fn get_arg_value(flag: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    if let Some(pos) = args.iter().position(|a| a == flag) {
        if let Some(val) = args.get(pos + 1) {
            if !val.is_empty() {
                return Some(val.clone());
            }
        }
    }
    let prefix = format!("{flag}=");
    for arg in &args {
        if let Some(rest) = arg.strip_prefix(&prefix) {
            if !rest.is_empty() {
                return Some(rest.to_string());
            }
        }
    }
    None
}

fn sanitize_job_id(id: &str) -> Result<String, String> {
    if id.is_empty() || id.len() > 128 {
        return Err("Invalid print job ID length (must be 1..=128)".to_string());
    }
    if !id
        .bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid print job ID characters (allowed: [A-Za-z0-9_-])".to_string());
    }
    Ok(id.to_string())
}

fn print_jobs_dir() -> PathBuf {
    resolve_data_dir().join("print_jobs")
}

#[tauri::command]
pub fn desktop_get_print_studio_mode() -> PrintStudioModeInfo {
    let is_print_studio = is_print_studio_process();
    let job_id = get_arg_value("--job").and_then(|v| sanitize_job_id(&v).ok());
    let doc_id = get_arg_value("--doc-id");
    let folder_id = get_arg_value("--folder-id");

    PrintStudioModeInfo {
        is_print_studio,
        job_id,
        doc_id,
        folder_id,
    }
}

#[tauri::command]
pub fn desktop_save_print_job(
    app: tauri::AppHandle,
    job_id: String,
    payload_json: String,
) -> Result<String, String> {
    let _ = &app;
    let safe_id = sanitize_job_id(&job_id)?;
    let jobs_dir = print_jobs_dir();
    fs::create_dir_all(&jobs_dir)
        .map_err(|e| format!("Failed to create print_jobs directory: {e}"))?;

    let path = jobs_dir.join(format!("{safe_id}.json"));
    let tmp_path = jobs_dir.join(format!("{safe_id}.json.tmp"));
    fs::write(&tmp_path, payload_json.as_bytes())
        .map_err(|e| format!("Failed to write print job file: {e}"))?;

    if let Err(rename_err) = fs::rename(&tmp_path, &path) {
        let _ = fs::remove_file(&tmp_path);
        fs::write(&path, payload_json.as_bytes())
            .map_err(|e| format!("Failed to save print job file ({rename_err}; {e})"))?;
    }

    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn desktop_load_print_job(app: tauri::AppHandle, job_id: String) -> Result<String, String> {
    let _ = &app;
    let safe_id = sanitize_job_id(&job_id)?;
    let path = print_jobs_dir().join(format!("{safe_id}.json"));
    fs::read_to_string(&path).map_err(|e| format!("Failed to load print job '{safe_id}': {e}"))
}

#[tauri::command]
pub async fn desktop_open_print_studio(
    app: tauri::AppHandle,
    job_id: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let safe_id_opt = match job_id {
        Some(ref raw) if !raw.is_empty() => Some(sanitize_job_id(raw)?),
        _ => None,
    };

    let clean_title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty());

    let url = match &safe_id_opt {
        Some(safe_id) => format!("index.html?print-studio=1&job={safe_id}"),
        None => "index.html?print-studio=1".to_string(),
    };

    if let Some(win) = app.get_webview_window("print-studio") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        if let Some(ref t) = clean_title {
            let _ = win.set_title(t);
        }
        if let Some(ref safe_id) = safe_id_opt {
            let encoded_id = serde_json::to_string(safe_id).unwrap_or_else(|_| "\"\"".to_string());
            let eval_js = format!(
                "window.__PRINT_STUDIO_RECEIVE_JOB && window.__PRINT_STUDIO_RECEIVE_JOB({});",
                encoded_id
            );
            let _ = win.eval(&eval_js);
        }
        return Ok(());
    }

    let win_title = clean_title.unwrap_or_else(|| DEFAULT_PRINT_STUDIO_TITLE.to_string());
    WebviewWindowBuilder::new(&app, "print-studio", WebviewUrl::App(url.into()))
        .title(win_title)
        .inner_size(1280.0, 860.0)
        .min_inner_size(920.0, 620.0)
        .center()
        .visible(true)
        .focused(true)
        .build()
        .map_err(|e| format!("Failed to open Legal Print Studio window: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn desktop_launch_print_studio_process(
    app: tauri::AppHandle,
    job_id: Option<String>,
    doc_id: Option<String>,
    folder_id: Option<String>,
) -> Result<(), String> {
    let _ = &app;
    let safe_job_id = match job_id {
        Some(ref raw) if !raw.is_empty() => Some(sanitize_job_id(raw)?),
        _ => None,
    };

    let cur_exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = cur_exe
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let studio_exe_candidate = exe_dir.join("Legal Print Studio.exe");
    let target_exe = if studio_exe_candidate.exists() {
        studio_exe_candidate
    } else {
        cur_exe
    };

    let mut cmd = std::process::Command::new(&target_exe);
    cmd.current_dir(&exe_dir);
    cmd.arg("--print-studio");

    if let Some(ref jid) = safe_job_id {
        cmd.arg("--job").arg(jid);
    }
    if let Some(ref did) = doc_id {
        let trimmed = did.trim();
        if !trimmed.is_empty() {
            cmd.arg("--doc-id").arg(trimmed);
        }
    }
    if let Some(ref fid) = folder_id {
        let trimmed = fid.trim();
        if !trimmed.is_empty() {
            cmd.arg("--folder-id").arg(trimmed);
        }
    }

    cmd.spawn()
        .map_err(|e| format!("Failed to launch Legal Print Studio process: {e}"))?;

    Ok(())
}

#[tauri::command]
pub fn desktop_close_print_studio(app: tauri::AppHandle) -> Result<(), String> {
    if is_print_studio_process() {
        app.exit(0);
    } else if let Some(win) = app.get_webview_window("print-studio") {
        win.close()
            .map_err(|e| format!("Failed to close Legal Print Studio window: {e}"))?;
    }
    Ok(())
}
