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

rem Install dependencies (only when missing)
if not exist node_modules (
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
  call npm run build -w @as400web/web-ui
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

echo ==^> starting: http://localhost:%PORT%  ^(Ctrl+C to stop^)
node %ENVFILE% packages\server\dist\main.js %ARGS%
endlocal
