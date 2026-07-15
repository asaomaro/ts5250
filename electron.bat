@echo off
rem AS400 5250 エミュレーター — Electron デスクトップ版 起動（Windows）
rem   ワークスペース依存 → ビルド（core/server + web-ui）→ Electron 依存 → Electron 起動。
rem
rem 使い方:
rem   electron.bat            未ビルドなら自動ビルドして起動
rem   electron.bat --build    強制再ビルド
rem
rem パッケージング（インストーラ生成）:
rem   npm run build ^&^& npm run build -w @as400web/web-ui
rem   cd electron ^&^& npm install ^&^& npm run dist
setlocal
cd /d "%~dp0"

set "FORCE_BUILD=0"
if /i "%~1"=="--build" set "FORCE_BUILD=1"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js ^(^>=20^) が必要です 1>&2
  exit /b 1
)

if not exist node_modules (
  echo ==^> npm install
  call npm install
)

set "NEED_BUILD=%FORCE_BUILD%"
if not exist packages\server\dist\main.js set "NEED_BUILD=1"
if not exist packages\web-ui\dist\index.html set "NEED_BUILD=1"
if "%NEED_BUILD%"=="1" (
  echo ==^> ビルド（core / server）
  call npm run build
  echo ==^> ビルド（web-ui / Vite）
  call npm run build -w @as400web/web-ui
)

if not exist electron\node_modules (
  echo ==^> Electron 依存のインストール（electron/）
  pushd electron
  call npm install
  popd
)

echo ==^> Electron 起動
cd electron
call npm start
endlocal
