#!/usr/bin/env bash
# ts5250 — Electron デスクトップ版の実行ファイル生成（Linux / macOS / WSL）
#   ワークスペース依存 → ビルド（ライブラリ/server + web-ui）→ Electron 依存 → アプリ一式の組み立て
#   → 実行ファイル生成。
#
# 使い方:
#   ./electron.sh            # 未ビルド・ソースが新しければ自動ビルドしてから生成
#   ./electron.sh --build    # 強制再ビルドしてから生成
#
# 生成物は electron/dist/ に出ます。**Windows は単一のインストーラ exe**
# （ワンクリック・ユーザー単位。%LOCALAPPDATA% に入るので管理者権限は不要。
# 実行先に Node.js も不要）、Linux は AppImage、macOS は dmg。
# 実行時依存はアプリの中に入ります（electron/scripts/prepare-app.mjs が組み立て）。
#
# **Windows 用 exe は Windows 上で `electron.bat` を実行して作ります**——
# NSIS を使うため、Linux から作るには wine が要ります。
set -euo pipefail
cd "$(dirname "$0")"

FORCE_BUILD=0
[ "${1:-}" = "--build" ] && FORCE_BUILD=1

command -v node >/dev/null 2>&1 || { echo "Node.js が必要です（必要版は package.json の engines.node）" >&2; exit 1; }
# **バージョンまで見る。** ビルドに使う vite / rolldown は新しめの Node を要求し、満たさないと
# ネイティブバイナリの取得あたりで落ちる。npm の engines は既定で警告どまりなので止まらず、
# **古い dist が残ったまま先へ進む**——配信されるのは古い UI なのに画面は動くので気づけない。
node launcher/preflight.mjs --check-node

# ワークスペース依存（未取得時 or ロックファイルが node_modules より新しいとき）。
# 「node_modules があるか」だけでは、ワークスペースが増えた版を pull したときに
# 新パッケージのリンクが無いまま進んでビルドが落ちる（start.sh と同じ理由。同じ判定にする）。
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "==> npm install"
  npm install
fi

# ビルド（未ビルド / ソースが成果物より新しい / --build 指定時）。
# **「index.html があるか」だけでは足りない。** 存在だけを見ていた頃は、`dist` が
# **あるけど古い**状態を素通りし、何週間も前の UI を配信し続けていた（実際に起きた）。
if [ "$FORCE_BUILD" = 1 ] || [ "$(node launcher/preflight.mjs --needs-build)" = 1 ]; then
  echo "==> ビルド（ライブラリ / server）"
  npm run build
  echo "==> ビルド（web-ui / Vite）"
  npm run build -w @ts5250/web-ui
fi

# Electron 依存（electron/ 配下に個別インストール）
if [ ! -d electron/node_modules ]; then
  echo "==> Electron 依存のインストール（electron/）"
  ( cd electron && npm install )
fi

echo "==> アプリ一式の組み立て＋実行ファイル生成（electron-builder）"
cd electron
npm run dist
echo "==> 完了。生成物は electron/dist/ にあります"
