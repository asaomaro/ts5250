#!/usr/bin/env bash
#
# テストスイートを繰り返し実行し、**落ちた回の全出力を保存する**。
#
# 低頻度で再現しない失敗（flaky）を追うための道具。素の `npm test` を目視で回すと、
# 落ちた瞬間の assertion がスクロールで流れるか、`| tail` や `| grep` で捨てられてしまい、
# 「どのテストが落ちたか」しか残らない。**原因特定には assertion の中身が要る**ので、
# ここでは失敗した回のログを丸ごとファイルに残す。
#
# 使い方:
#   npm run test:flake-hunt            # 既定 20 回
#   npm run test:flake-hunt -- 100     # 回数を指定
#   npm run test:flake-hunt -- 50 --sequence.shuffle   # vitest への追加引数
#
# 出力: .flake-logs/fail-<連番>-<UTC時刻>.log（.gitignore 済み）
set -u

cd "$(dirname "$0")/.."

runs="${1:-20}"
case "$runs" in
  ''|*[!0-9]*) echo "usage: flake-hunt.sh [runs] [vitest args...]" >&2; exit 1 ;;
esac
shift 2>/dev/null || true

out=".flake-logs"
mkdir -p "$out"

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

fails=0
for i in $(seq 1 "$runs"); do
  npx vitest run "$@" > "$log" 2>&1
  status=$?
  # 終了コードだけでなく `×` 行も見る。片方だけだと取りこぼす回がある
  if [ "$status" -ne 0 ] || grep -qE '^ +× ' "$log"; then
    fails=$((fails + 1))
    dest="$out/fail-$(printf '%03d' "$i")-$(date -u +%Y%m%dT%H%M%SZ).log"
    cp "$log" "$dest"
    echo "--- FAIL (run $i/$runs) → $dest"
    grep -E '^ +× ' "$log" || echo "  (× 行なし: 終了コード $status。クラッシュの可能性)"
  fi
done

echo "flake-hunt: $fails / $runs 回が失敗"
[ "$fails" -eq 0 ] && echo "（再現せず。頻度が低いので回数を増やして再試行する）"
exit 0
