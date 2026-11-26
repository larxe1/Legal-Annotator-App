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
setlocal
set "RELEASE_NOTES="
set /p "RELEASE_NOTES=Release notes (press Enter for default): "
if not defined RELEASE_NOTES set "RELEASE_NOTES=Publish app update for laptop auto-updater"

echo [1/4] Bumping version and build number in version.json...
set "VER_TMP=%TEMP%\la_publish_ver.tmp"
if exist "%VER_TMP%" del /f /q "%VER_TMP%" >nul 2>&1
powershell -NoProfile -Command "$ErrorActionPreference = 'Stop'; $v = Get-Content 'version.json' -Raw | ConvertFrom-Json; $parts = $v.version.Split('.'); if ($parts.Length -lt 3) { throw 'Invalid semver in version.json' }; $parts[2] = [string]([int]$parts[2] + 1); $v.version = ($parts -join '.'); $v.build = [int]$v.build + 1; $v.updatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); $v.notes = $env:RELEASE_NOTES; [IO.File]::WriteAllText((Join-Path (Get-Location) 'version.json'), ($v | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false)); [IO.File]::WriteAllText($env:VER_TMP, $v.version, (New-Object System.Text.UTF8Encoding $false)); Write-Host ('New Version: v' + $v.version + ' (Build #' + $v.build + ')')"
if errorlevel 1 (
  echo Failed to update version.json!
  pause
  exit /b 1
)
set "NEW_VERSION="
set /p NEW_VERSION=<"%VER_TMP%"
del /f /q "%VER_TMP%" >nul 2>&1
if not defined NEW_VERSION (
  echo Failed to read new version!
  pause
  exit /b 1
)

echo [2/4] Closing running instance and running local compile check...
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

echo [3/4] Updating local Legal Annotator.exe...
copy /Y "src-tauri\target\release\legal-annotator-desktop.exe" "Legal Annotator.exe" > nul
if errorlevel 1 (
  echo Failed to copy Legal Annotator.exe!
  pause
  exit /b 1
)

echo [4/4] Tagging and pushing v%NEW_VERSION% to GitHub Actions...
set "GIT_EXE=C:\Users\ecmat\AppData\Local\Programs\MinGit\cmd\git.exe"
"%GIT_EXE%" add version.json
"%GIT_EXE%" add -u
"%GIT_EXE%" reset -q HEAD -- "Legal Annotator.exe" "Legal OCR Studio.exe"
"%GIT_EXE%" commit -m "Release v%NEW_VERSION%"
if errorlevel 1 (
  echo Git commit failed!
  pause
  exit /b 1
)
"%GIT_EXE%" tag "v%NEW_VERSION%"
if errorlevel 1 (
  echo Git tag failed!
  pause
  exit /b 1
)
"%GIT_EXE%" push origin main
if errorlevel 1 (
  echo Git push main failed!
  pause
  exit /b 1
)
"%GIT_EXE%" push origin "v%NEW_VERSION%"
if errorlevel 1 (
  echo Git push tag failed!
  pause
  exit /b 1
)

echo.
echo Done! GitHub Actions is building v%NEW_VERSION%.
echo Releases: https://github.com/larxe1/Legal-Annotator-App/releases
echo Launching updated local Legal Annotator...
start "" "Legal Annotator.exe"
