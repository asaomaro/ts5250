#!/usr/bin/env bash
# AS400 5250 エミュレーター — Electron デスクトップ版 起動（Linux / macOS / WSL）
#   ワークスペース依存 → ビルド（core/server + web-ui）→ Electron 依存 → Electron 起動。
#
# 使い方:
#   ./electron.sh            # 未ビルドなら自動ビルドして起動
#   ./electron.sh --build    # 強制再ビルド
#
# パッケージング（インストーラ生成）は:
#   npm run build && npm run build -w @as400web/web-ui
#   cd electron && npm install && npm run dist    # electron-builder（要 GUI/対象 OS）
set -euo pipefail
cd "$(dirname "$0")"

FORCE_BUILD=0
[ "${1:-}" = "--build" ] && FORCE_BUILD=1

command -v node >/dev/null 2>&1 || { echo "Node.js (>=20) が必要です" >&2; exit 1; }

# ワークスペース依存
if [ ! -d node_modules ]; then
  echo "==> npm install"
  npm install
fi

# ビルド（dist 未生成 or --build 指定時）
if [ "$FORCE_BUILD" = 1 ] || [ ! -f packages/server/dist/main.js ] || [ ! -f packages/web-ui/dist/index.html ]; then
  echo "==> ビルド（core / server）"
  npm run build
  echo "==> ビルド（web-ui / Vite）"
  npm run build -w @as400web/web-ui
fi

# Electron 依存（electron/ 配下に個別インストール）
if [ ! -d electron/node_modules ]; then
  echo "==> Electron 依存のインストール（electron/）"
  ( cd electron && npm install )
fi

echo "==> Electron 起動"
cd electron
exec npm start
