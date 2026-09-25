@echo off
rem Keep this file ASCII-only: cmd.exe on a cp932 console mis-parses multibyte
rem (UTF-8) bytes in .bat files, which turns comment lines into stray commands.
chcp 65001 >nul
rem ts5250 - VSCode extension .vsix builder (Windows)
rem   workspace deps -> build (libs/server + web-ui) -> extension deps/build
rem   -> stage the bundled server (vscode-extension\scripts\prepare-server.mjs)
rem   -> build .vsix (vsce)
rem
rem Usage:
rem   vscode-extension.bat            auto-build when not built or stale, then package
rem   vscode-extension.bat --build    force rebuild, then package
rem
rem Output: vscode-extension\ts5250-vscode-<version>.vsix (vsce's default location)
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "FORCE_BUILD=0"
if /i "%~1"=="--build" set "FORCE_BUILD=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required ^(see engines.node in package.json^) 1>&2
  exit /b 1
)

rem Check the VERSION too, not just that node exists (see start.bat/electron.bat for why:
rem an old Node fails the build silently and a stale dist gets shipped without complaint).
node launcher\preflight.mjs --check-node
if errorlevel 1 exit /b 1

rem Same staleness check as start.bat/electron.bat: node_modules alone does not tell
rem whether a newly added workspace has been linked.
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

rem Decide whether a build is needed (prepare-server.mjs requires packages/*/dist and
rem packages/web-ui/dist to already exist).
set "NEED_BUILD=%FORCE_BUILD%"
if not "%NEED_BUILD%"=="1" (
  for /f %%s in ('node launcher\preflight.mjs --needs-build') do set "NEED_BUILD=%%s"
)
if "%NEED_BUILD%"=="1" (
  echo ==^> build ^(libs / server^)
  call npm run build
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

rem The extension is its own npm package (not a workspace member): separate
rem package.json / package-lock.json, so its deps install separately.
if not exist vscode-extension\node_modules (
  echo ==^> install extension deps ^(vscode-extension\^)
  pushd vscode-extension
  call npm install
  popd
)

echo ==^> build ^(extension^)
pushd vscode-extension
call npm run build
if errorlevel 1 (
  popd
  echo build failed ^(extension^) 1>&2
  exit /b 1
)
popd

echo ==^> staging the bundled server ^(vscode-extension\server-stage\^)
node vscode-extension\scripts\prepare-server.mjs
if errorlevel 1 (
  echo staging failed 1>&2
  exit /b 1
)

echo ==^> building .vsix
pushd vscode-extension
call npx --yes @vscode/vsce package
if errorlevel 1 (
  popd
  echo vsce package failed 1>&2
  exit /b 1
)
popd

echo ==^> done. .vsix is in vscode-extension\
dir /b vscode-extension\*.vsix
endlocal
