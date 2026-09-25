#!/usr/bin/env bash
# ts5250 — VSCode拡張機能の .vsix 生成（Linux / macOS / WSL）
#   ワークスペース依存 → ビルド（ライブラリ/server + web-ui）→ 拡張機能の依存/ビルド
#   → 配布用サーバー一式の組み立て（vscode-extension/scripts/prepare-server.mjs）
#   → .vsix 作成（vsce）。
#
# 使い方:
#   ./vscode-extension.sh            # 未ビルド・ソースが新しければ自動ビルドしてから作る
#   ./vscode-extension.sh --build    # 強制再ビルドしてから作る
#
# 生成物は vscode-extension/ 直下（vsce の既定の出力先）に
# `ts5250-vscode-<version>.vsix` として出ます。
set -euo pipefail
cd "$(dirname "$0")"

FORCE_BUILD=0
[ "${1:-}" = "--build" ] && FORCE_BUILD=1

command -v node >/dev/null 2>&1 || { echo "Node.js が必要です（必要版は package.json の engines.node）" >&2; exit 1; }
# バージョンまで見る（start.sh/electron.shと同じ理由: 古い Node だとビルドが黙って失敗し、
# 古い dist が残ったまま先へ進んでしまう）
node launcher/preflight.mjs --check-node

# ワークスペース依存（未取得時 or ロックファイルが node_modules より新しいとき）。
# start.sh/electron.shと同じ判定（理由もそちらを参照）。
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "==> npm install"
  npm install
fi

# ビルド（未ビルド / ソースが成果物より新しい / --build 指定時）。
# vscode-extension/scripts/prepare-server.mjs が packages/*/dist と
# packages/web-ui/dist の存在を前提にするため、ここで済ませておく。
if [ "$FORCE_BUILD" = 1 ] || [ "$(node launcher/preflight.mjs --needs-build)" = 1 ]; then
  echo "==> ビルド（ライブラリ / server）"
  npm run build
  echo "==> ビルド（web-ui / Vite）"
  npm run build -w @ts5250/web-ui
fi

# 拡張機能自体の依存（vscode-extension/ は npm workspaces の対象外——
# 個別の package.json / package-lock.json を持つ独立したnpmパッケージ）
if [ ! -d vscode-extension/node_modules ]; then
  echo "==> 拡張機能の依存のインストール（vscode-extension/）"
  ( cd vscode-extension && npm install )
fi

echo "==> ビルド（拡張機能）"
( cd vscode-extension && npm run build )

echo "==> 配布用サーバー一式を組み立て（vscode-extension/server-stage/）"
node vscode-extension/scripts/prepare-server.mjs

echo "==> .vsix を作成"
( cd vscode-extension && npx --yes @vscode/vsce package )

echo "==> 完了。vscode-extension/ 直下に .vsix ができています"
ls -1 vscode-extension/*.vsix
