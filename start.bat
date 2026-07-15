@echo off
rem AS400 5250 Web エミュレーター起動スクリプト（Windows）
rem   HTTP サーバーを起動し、ビルド済み Web UI を配信する。ブラウザで http://localhost:<port> を開く。
rem
rem 使い方:
rem   start.bat                        既定ポート 3400 で起動（未ビルドなら自動ビルド）
rem   start.bat --port 8080            ポート指定
rem   start.bat --build                強制再ビルド
rem   start.bat --profiles path.json   接続プロファイル指定（既定は profiles.local.json / profiles.json 自動検出）
rem
rem   MCP を stdio で使う場合:
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
  echo Node.js ^(^>=20^) が必要です 1>&2
  exit /b 1
)

rem 依存インストール（未取得時のみ）
if not exist node_modules (
  echo ==^> npm install
  call npm install
)

rem ビルド判定
set "NEED_BUILD=%FORCE_BUILD%"
if not exist packages\server\dist\main.js set "NEED_BUILD=1"
if not exist packages\web-ui\dist\index.html set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
  echo ==^> ビルド（core / server）
  call npm run build
  echo ==^> ビルド（web-ui / Vite）
  call npm run build -w @as400web/web-ui
)

rem 接続プロファイルの自動検出（未指定時）
if "%PROFILES%"=="" if exist profiles.local.json set "PROFILES=profiles.local.json"
if "%PROFILES%"=="" if exist profiles.json set "PROFILES=profiles.json"

rem .env があれば読み込む（Node 20.6+ の --env-file）
set "ENVFILE="
if exist .env set "ENVFILE=--env-file=.env"

set "ARGS=--http %PORT% --web-root packages/web-ui/dist"
if not "%PROFILES%"=="" (
  set "ARGS=%ARGS% --profiles %PROFILES%"
  echo ==^> profiles: %PROFILES%
)

echo ==^> 起動: http://localhost:%PORT%  ^(停止は Ctrl+C^)
node %ENVFILE% packages\server\dist\main.js %ARGS%
endlocal
