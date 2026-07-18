#!/usr/bin/env bash
# AS400 5250 Web エミュレーター起動スクリプト（Linux / macOS / WSL）
#   HTTP サーバーを起動し、ビルド済み Web UI を配信する。ブラウザで http://localhost:<port> を開く。
#
# 使い方:
#   ./start.sh                     # 既定ポート 3400 で起動（未ビルドなら自動ビルド）
#   ./start.sh --port 8080         # ポート指定
#   ./start.sh --build             # 強制再ビルド
#   ./start.sh --profiles path.json# 接続プロファイル指定（既定は profiles.local.json / profiles.json を自動検出）
#
#   MCP を stdio で使う場合は本スクリプトではなく:
#     node packages/server/dist/main.js --stdio --profiles profiles.local.json
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3400}"
FORCE_BUILD=0
PROFILES=""

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --build) FORCE_BUILD=1; shift ;;
    --profiles) PROFILES="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ./start.sh [--port <n>] [--build] [--profiles <path>]"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

command -v node >/dev/null 2>&1 || { echo "Node.js (>=20) が必要です" >&2; exit 1; }

# 依存インストール（未取得時のみ）
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

# 接続プロファイルの自動検出（未指定時）
if [ -z "$PROFILES" ]; then
  for f in profiles.local.json profiles.json; do
    if [ -f "$f" ]; then PROFILES="$f"; break; fi
  done
fi

ARGS=(--http "$PORT" --web-root packages/web-ui/dist)
if [ -n "$PROFILES" ]; then
  ARGS+=(--profiles "$PROFILES")
  echo "==> profiles: $PROFILES"
fi
# 単一利用者向けのローカル起動なので、UI からのパスワード保存用 master key を無ければ自動生成して .env に保存する。
# マルチユーザー運用では AS400_SECRET_KEY を明示管理し、この起動スクリプトは使わない想定。
ARGS+=(--auto-secret-key)

# .env があれば読み込む（プロファイルの passwordEnv 等）。Node 20.6+ の --env-file を利用
NODE_ARGS=()
if [ -f .env ]; then NODE_ARGS+=(--env-file=.env); fi

echo "==> 起動: http://localhost:$PORT  (停止は Ctrl+C)"
exec node "${NODE_ARGS[@]}" packages/server/dist/main.js "${ARGS[@]}"
