#!/usr/bin/env sh
# 3270 の検証環境（ホスト＋参照クライアント）を用意する。
#
#   ホスト        : TK4-（MVS 3.8j ターンキー）を docker で起動。port 3270 / 8038
#   参照クライアント: s3270（x3270 suite。BSD-3-Clause）を docker イメージに焼く
#
# **なぜ docker なのか**: この開発コンテナには sudo が無く、ホストへ apt できない。
# また TK4- は Hercules の設定一式を伴うので、イメージで持つのが最も再現性が高い。
#
# 装置（`conf/tk4-.cnf` 実測）:
#   00C0-00C6  local 3270 devices (VTAM)  … 既定で掴む。Hercules コンソール
#   03C0-03C7  local 3270 terminals (TCAM) … **TSO 端末**（`IKJ54012A ENTER LOGON`）
#
# 装置の指定は端末タイプ文字列に `@<装置番号>` を付ける（基本 TN3270 の慣行）。
#   例: IBM-3279-2-E@03C0
#
# 使い方:
#   sh testenv.sh up      環境を起動（イメージが無ければ取得・構築）
#   sh testenv.sh down    片付け
#   sh testenv.sh status  状態表示
set -eu

TK4_IMAGE=rattydave/docker-ubuntu-hercules-mvs:latest
TK4_NAME=tn3270-tk4
S3270_IMAGE=ts5250-s3270:latest
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

build_s3270() {
  if docker image inspect "$S3270_IMAGE" >/dev/null 2>&1; then return 0; fi
  echo "s3270 イメージを構築中..."
  docker build -q -t "$S3270_IMAGE" -f "$HERE/s3270.Dockerfile" "$HERE" >/dev/null
}

case "${1:-up}" in
  up)
    build_s3270
    if docker ps --format '{{.Names}}' | grep -qx "$TK4_NAME"; then
      echo "TK4- は既に起動しています"
    else
      docker rm -f "$TK4_NAME" >/dev/null 2>&1 || true
      echo "TK4- を起動中（MVS の IPL に 1 分ほどかかります）..."
      docker run -d --name "$TK4_NAME" -p 3270:3270 -p 8038:8038 "$TK4_IMAGE" >/dev/null
    fi
    # **IPL の完了を待つ。**
    #
    # ここを待たないと「画面が来ない」という紛らわしい形で E2E が落ちる（実際に踏んだ）。
    # 判定は `wait-ready.mjs` に任せる——**実際に画面が届くこと**だけが確実な合図で、
    # HTTP コンソールの応答も syslog の IPL 完了メッセージも**早すぎた**（どちらも実測）。
    if [ ! -f "$HERE/../../dist/transport/tcp.js" ]; then
      echo "警告: dist が無いので待機を省略します。先に npm run build を実行してください" >&2
      echo "TN3270_E2E=1 で E2E テストを実行できます（IPL 完了まで 1 分ほど待つこと）"
      exit 0
    fi
    printf "MVS の IPL を待っています"
    if node "$HERE/wait-ready.mjs" 127.0.0.1 3270 180; then
      echo "TN3270_E2E=1 で E2E テストを実行できます"
      exit 0
    fi
    echo "警告: IPL が終わりません。docker logs $TK4_NAME を確認してください" >&2
    exit 1
    ;;
  down)
    docker rm -f "$TK4_NAME" >/dev/null 2>&1 || true
    echo "TK4- を停止しました（s3270 イメージは残します）"
    ;;
  status)
    docker ps --filter "name=$TK4_NAME" --format 'TK4-: {{.Status}} {{.Ports}}' || true
    docker image inspect "$S3270_IMAGE" >/dev/null 2>&1 \
      && echo "s3270 イメージ: あり" || echo "s3270 イメージ: なし"
    ;;
  *)
    echo "使い方: sh testenv.sh [up|down|status]" >&2
    exit 1
    ;;
esac
