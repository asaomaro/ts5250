#!/usr/bin/env bash
#
# 同梱している Windows 版 DLL を、いまのソースから作り直す。
#
#   crates/hllapi/tools/update-prebuilt.sh
#
# **Rust の入っていない環境の利用者のために DLL をリポジトリへ入れている。**
# ソースを変えたらこれを実行すること——実行し忘れると `prebuilt-fresh.test.ts` が落ちる
# （**黙って古い DLL が配られる**のを防ぐため）。
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/.."

"$here/build.sh" --windows-only

mkdir -p "$crate/prebuilt/x64" "$crate/prebuilt/x86"
cp "$crate/target/x86_64-pc-windows-gnu/release/ts5250hllapi.dll" "$crate/prebuilt/x64/"
cp "$crate/target/i686-pc-windows-gnu/release/ts5250hllapi.dll" "$crate/prebuilt/x86/"

python3 "$here/prebuilt-manifest.py" --write
python3 "$here/check-dll.py" "$crate/prebuilt/x64/ts5250hllapi.dll" "$crate/prebuilt/x86/ts5250hllapi.dll"
printf '\033[1m==> prebuilt を更新しました\033[0m\n' >&2
