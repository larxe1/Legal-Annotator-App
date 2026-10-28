@echo off
cd /d "%~dp0"
rem ── Safety: this script only works on the main PC that builds the app. ──
rem On any other computer (e.g. the laptop) it downloads the latest version instead
rem of trying to build/publish, which used to fail with an error in this window.
if not exist "D:\DevTools\cargo\bin\cargo.exe" (
  echo.
  echo  NOTE: This file is only for the main PC that builds the app.
  echo  On this computer, Legal Annotator updates itself from inside the app:
  echo    Settings ^> App Version ^& Updates ^> Install ^& restart
  echo.
  echo  Downloading the latest version for this computer instead...
  call "%~dp0Update-Legal-Annotator.bat"
  exit /b
)
echo [1/4] Incrementing build number in version.json...
powershell -NoProfile -Command "$v = Get-Content 'version.json' -Raw | ConvertFrom-Json; $v.build = [int]$v.build + 1; $v.updatedAt = (Get-Date).ToString('yyyy-MM-ddTHH:mm:sszzz'); [IO.File]::WriteAllText((Join-Path (Get-Location) 'version.json'), ($v | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false)); Write-Host ('New Build Number: #' + $v.build)"

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
