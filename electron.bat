@echo off
rem Keep this file ASCII-only: cmd.exe on a cp932 console mis-parses multibyte
rem (UTF-8) bytes in .bat files, which turns comment lines into stray commands.
rem chcp 65001 only fixes DISPLAY of the child process (node) UTF-8 output below.
chcp 65001 >nul
rem AS400 5250 emulator - Electron desktop packager (Windows)
rem   workspace deps -> build (core/server + web-ui) -> Electron deps -> build exe (installer)
rem
rem Usage:
rem   electron.bat            auto-build if not built, then build the exe (installer)
rem   electron.bat --build    force rebuild, then build the exe (installer)
rem
rem The generated installer is written to electron\dist\ .
setlocal
cd /d "%~dp0"

set "FORCE_BUILD=0"
if /i "%~1"=="--build" set "FORCE_BUILD=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ^(^>=20^) is required 1>&2
  exit /b 1
)

rem Same staleness check as start.bat: node_modules alone does not tell whether a newly
rem added workspace has been linked (see start.bat for the failure this prevents).
set "DEPS_STALE="
if not exist node_modules set "DEPS_STALE=1"
if not exist node_modules\.package-lock.json set "DEPS_STALE=1"
if not defined DEPS_STALE (
  for /f %%s in ('powershell -NoProfile -Command "if ((Get-Item package-lock.json).LastWriteTimeUtc -gt (Get-Item node_modules/.package-lock.json).LastWriteTimeUtc) { 1 } else { 0 }"') do if "%%s"=="1" set "DEPS_STALE=1"
)
if defined DEPS_STALE (
  echo ==^> npm install
  call npm install
)

set "NEED_BUILD=%FORCE_BUILD%"
if not exist packages\server\dist\main.js set "NEED_BUILD=1"
if not exist packages\web-ui\dist\index.html set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
  echo ==^> build ^(core / server^)
  call npm run build
  echo ==^> build ^(web-ui / Vite^)
  call npm run build -w @as400web/web-ui
)

if not exist electron\node_modules (
  echo ==^> install Electron deps ^(electron/^)
  pushd electron
  call npm install
  popd
)

echo ==^> building exe ^(electron-builder^)
cd electron
call npm run dist
echo ==^> done. installer is in electron\dist\
endlocal
