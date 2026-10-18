@echo off
cd /d "%~dp0"
echo [1/4] Incrementing build number in version.json...
powershell -NoProfile -Command "$v = Get-Content 'version.json' | ConvertFrom-Json; $v.build = [int]$v.build + 1; $v.updatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); $v | ConvertTo-Json | Set-Content 'version.json' -Encoding UTF8; Write-Host ('New Build Number: #' + $v.build)"

echo [2/4] Closing running instance and building Legal Annotator.exe...
powershell -NoProfile -Command "Stop-Process -Name 'Legal Annotator','legal-annotator-desktop' -Force -ErrorAction SilentlyContinue"
timeout /t 1 /nobreak > nul
set RUSTUP_HOME=D:\DevTools\rustup
set CARGO_HOME=D:\DevTools\cargo
set TEMP=D:\DevTools\temp
set TMP=D:\DevTools\temp
"D:\DevTools\cargo\bin\cargo.exe" build --release --manifest-path "src-tauri\Cargo.toml"
if errorlevel 1 (
  echo Build failed!
  pause
  exit /b 1
)

echo [3/4] Updating standalone Legal Annotator.exe...
copy /Y "src-tauri\target\release\legal-annotator-desktop.exe" "Legal Annotator.exe" > nul

echo [4/4] Pushing update to GitHub so your laptop auto-updates...
"C:\Users\ecmat\AppData\Local\Programs\MinGit\cmd\git.exe" add -A
"C:\Users\ecmat\AppData\Local\Programs\MinGit\cmd\git.exe" commit -m "Publish app update for laptop auto-updater"
"C:\Users\ecmat\AppData\Local\Programs\MinGit\cmd\git.exe" push origin main

echo Done! Launching updated Legal Annotator...
start "" "Legal Annotator.exe"
