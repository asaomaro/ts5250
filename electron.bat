@echo off
rem Keep this file ASCII-only: cmd.exe on a cp932 console mis-parses multibyte
rem (UTF-8) bytes in .bat files, which turns comment lines into stray commands.
rem chcp 65001 only fixes DISPLAY of the child process (node) UTF-8 output below.
chcp 65001 >nul
rem ts5250 - Electron desktop packager (Windows)
rem   workspace deps -> build (libs/server + web-ui) -> Electron deps -> stage app -> build exe
rem
rem Usage:
rem   electron.bat            auto-build when not built or stale, then build the exe
rem   electron.bat --build    force rebuild, then build the exe
rem
rem Output: electron\dist\ts5250-<version>-setup.exe
rem   A single exe to hand out. It is a one-click per-user installer:
rem   installs under %LOCALAPPDATA% (no admin), makes shortcuts, then starts
rem   instantly every time. No Node.js needed on the target machine - runtime
rem   deps are packed inside (see electron/scripts/prepare-app.mjs).
rem   Settings live in %APPDATA% and survive uninstall.
rem
rem   Why not a portable exe: the portable stub deletes and re-extracts the whole
rem   ~300 MB payload on EVERY launch, so startup took minutes and never got faster.
setlocal
cd /d "%~dp0"

set "FORCE_BUILD=0"
if /i "%~1"=="--build" set "FORCE_BUILD=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required ^(see engines.node in package.json^) 1>&2
  exit /b 1
)

rem Check the VERSION too, not just that node exists. vite / rolldown need a recent Node and
rem the build dies on an older one (fetching the native binary), while npm's own engines check
rem only warns and keeps going. Without this gate the script walks past a failed build and
rem serves a STALE dist - the screen still works, so it looks like a feature regression
rem rather than a build that never ran.
node launcher\preflight.mjs --check-node
if errorlevel 1 exit /b 1

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

rem Decide whether a build is needed.
rem
rem Checking only "does index.html exist" is not enough: a dist that EXISTS BUT IS STALE was
rem walked past, and weeks-old UI kept being served (this actually happened). preflight
rem compares source timestamps against the last successful build.
set "NEED_BUILD=%FORCE_BUILD%"
if not "%NEED_BUILD%"=="1" (
  for /f %%s in ('node launcher\preflight.mjs --needs-build') do set "NEED_BUILD=%%s"
)
if "%NEED_BUILD%"=="1" (
  echo ==^> build ^(libs / server^)
  call npm run build
  rem A failed build must STOP here. Without this the script carried on and started the
  rem server against the previous dist, which is exactly how stale UI gets served silently.
  if errorlevel 1 (
    echo build failed ^(libs / server^) 1>&2
    exit /b 1
  )
  echo ==^> build ^(web-ui / Vite^)
  call npm run build -w @ts5250/web-ui
  if errorlevel 1 (
    echo build failed ^(web-ui^) 1>&2
    exit /b 1
  )
)

if not exist electron\node_modules (
  echo ==^> install Electron deps ^(electron/^)
  pushd electron
  call npm install
  popd
)

echo ==^> staging app + building exe ^(electron-builder^)
cd electron
call npm run dist
if errorlevel 1 (
  echo build failed 1>&2
  exit /b 1
)
echo ==^> done. installer exe is in electron\dist\
endlocal
