@echo off
setlocal
cd /d "%~dp0"
title Legal Annotator - Update This Computer
echo.
echo  Legal Annotator - download the latest version onto THIS computer
echo  ---------------------------------------------------------------
echo  (Normally you don't need this: the app updates itself from
echo   Settings ^> App Version ^& Updates ^> Install ^& restart.)
echo.
echo [1/3] Downloading the latest Legal Annotator from GitHub (about 33 MB)...
if exist "Legal Annotator.download" del /f /q "Legal Annotator.download" >nul 2>&1
"%SystemRoot%\System32\curl.exe" -L --fail --show-error --retry 3 --retry-delay 2 -A "LegalAnnotatorDesktop-Updater" -o "Legal Annotator.download" "https://raw.githubusercontent.com/larxe1/Legal-Annotator-App/main/Legal%%20Annotator.exe"
if errorlevel 1 goto :fail
for %%A in ("Legal Annotator.download") do if %%~zA LSS 10000000 goto :fail

echo [2/3] Closing Legal Annotator (your notes are saved automatically)...
taskkill /IM "Legal Annotator.exe" >nul 2>&1
timeout /t 3 /nobreak >nul
taskkill /IM "Legal Annotator.exe" /F >nul 2>&1
timeout /t 1 /nobreak >nul

echo [3/3] Installing...
move /Y "Legal Annotator.download" "Legal Annotator.exe" >nul
if errorlevel 1 goto :fail

echo.
echo  Done! Starting the updated Legal Annotator...
start "" "Legal Annotator.exe"
timeout /t 3 >nul
exit /b 0

:fail
echo.
echo  The update could not be downloaded or installed.
echo  Please check your internet connection, close Legal Annotator, and try again.
if exist "Legal Annotator.download" del /f /q "Legal Annotator.download" >nul 2>&1
pause
exit /b 1
