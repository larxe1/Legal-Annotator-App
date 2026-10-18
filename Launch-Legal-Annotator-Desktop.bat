@echo off
cd /d "%~dp0"
if exist "src-tauri\target\release\legal-annotator-desktop.exe" (
  start "" "src-tauri\target\release\legal-annotator-desktop.exe"
) else if exist "src-tauri\target\debug\legal-annotator-desktop.exe" (
  start "" "src-tauri\target\debug\legal-annotator-desktop.exe"
) else (
  echo Desktop binary not built yet. Building now...
  set RUSTUP_HOME=D:\DevTools\rustup
  set CARGO_HOME=D:\DevTools\cargo
  set TEMP=D:\DevTools\temp
  set TMP=D:\DevTools\temp
  "D:\DevTools\cargo\bin\cargo.exe" build --release --manifest-path src-tauri\Cargo.toml
  start "" "src-tauri\target\release\legal-annotator-desktop.exe"
)
