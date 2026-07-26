#!/usr/bin/env bash
# AS400 5250 エミュレーター — Electron デスクトップ版 exe 生成（Linux / macOS / WSL）
#   ワークスペース依存 → ビルド（core/server + web-ui）→ Electron 依存 → exe（インストーラ）生成。
#
# 使い方:
#   ./electron.sh            # 未ビルドなら自動ビルドしてから exe（インストーラ）を生成
#   ./electron.sh --build    # 強制再ビルドしてから exe（インストーラ）を生成
#
# 生成物（インストーラ）は electron/dist/ に出力されます。
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

echo "==> exe 生成（electron-builder）"
cd electron
npm run dist
echo "==> 完了。インストーラは electron/dist/ にあります"
