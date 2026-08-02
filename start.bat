@echo off
rem Keep this file ASCII-only: cmd.exe on a cp932 console mis-parses multibyte
rem (UTF-8) bytes in .bat files, which turns comment lines into stray commands.
rem chcp 65001 only fixes DISPLAY of the child process (node) UTF-8 output below.
chcp 65001 >nul
rem AS400 5250 Web emulator launcher (Windows)
rem   Starts the HTTP server and serves the pre-built Web UI.
rem   Open http://localhost:<port> in a browser.
rem
rem Usage:
rem   start.bat                        default port 3400 (auto-build if not built)
rem   start.bat --port 8080            specify port
rem   start.bat --build                force rebuild
rem   start.bat --profiles path.json   connection profiles (auto: profiles.local.json / profiles.json)
rem
rem   Use MCP over stdio:
rem     node packages\server\dist\main.js --stdio --profiles profiles.local.json
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PORT=3400"
set "FORCE_BUILD=0"
set "PROFILES="

:parse
if "%~1"=="" goto endparse
if /i "%~1"=="--port" ( set "PORT=%~2" & shift & shift & goto parse )
if /i "%~1"=="--build" ( set "FORCE_BUILD=1" & shift & goto parse )
if /i "%~1"=="--profiles" ( set "PROFILES=%~2" & shift & shift & goto parse )
if /i "%~1"=="-h" goto usage
if /i "%~1"=="--help" goto usage
echo unknown arg: %~1 1>&2
exit /b 1
:usage
echo Usage: start.bat [--port ^<n^>] [--build] [--profiles ^<path^>]
exit /b 0
:endparse

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ^(^>=20^) is required 1>&2
  exit /b 1
)

rem Install dependencies (when missing, or when the lockfile is newer than node_modules).
rem
rem Checking only for node_modules is not enough: pulling a revision that adds a workspace
rem leaves the old node_modules in place without a link for the new package, and the build
rem then fails with "Cannot find module '@ts5250/...'" (this actually happened when
rem packages/ebcdic and packages/scs were added). npm rewrites node_modules/.package-lock.json
rem on every install, so a newer package-lock.json means the tree is stale.
rem PowerShell is used only for the timestamp comparison (present on every supported Windows).
set "DEPS_STALE="
if not exist node_modules set "DEPS_STALE=1"
if not exist node_modules\.package-lock.json set "DEPS_STALE=1"
rem Kept on one line on purpose: a "^" continuation inside for /f is a common batch pitfall.
rem The expression uses -gt (not ">") so cmd does not treat it as a redirection.
if not defined DEPS_STALE (
  for /f %%s in ('powershell -NoProfile -Command "if ((Get-Item package-lock.json).LastWriteTimeUtc -gt (Get-Item node_modules/.package-lock.json).LastWriteTimeUtc) { 1 } else { 0 }"') do if "%%s"=="1" set "DEPS_STALE=1"
)
if defined DEPS_STALE (
  echo ==^> npm install
  call npm install
)

rem Decide whether a build is needed
set "NEED_BUILD=%FORCE_BUILD%"
if not exist packages\server\dist\main.js set "NEED_BUILD=1"
if not exist packages\web-ui\dist\index.html set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
  echo ==^> build ^(core / server^)
  call npm run build
  echo ==^> build ^(web-ui / Vite^)
  call npm run build -w @ts5250/web-ui
)

rem Auto-detect connection profiles (when not specified)
if "%PROFILES%"=="" if exist profiles.local.json set "PROFILES=profiles.local.json"
if "%PROFILES%"=="" if exist profiles.json set "PROFILES=profiles.json"

rem Load .env if present (Node 20.6+ --env-file)
set "ENVFILE="
if exist .env set "ENVFILE=--env-file=.env"

set "ARGS=--http %PORT% --web-root packages/web-ui/dist"
if not "%PROFILES%"=="" (
  set "ARGS=%ARGS% --profiles %PROFILES%"
  echo ==^> profiles: %PROFILES%
)
rem Single-user local launch: auto-generate the UI password-save master key into .env if missing.
rem For multi-user setups, manage AS400_SECRET_KEY explicitly and do not use this script.
rem (start.sh has done this from the start; without it Windows fails with
rem  "secret key not configured; cannot store password" when saving an auto-signon password.)
set "ARGS=%ARGS% --auto-secret-key"

echo ==^> starting: http://localhost:%PORT%  ^(Ctrl+C to stop^)
node %ENVFILE% packages\server\dist\main.js %ARGS%
endlocal
