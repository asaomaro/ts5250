#!/usr/bin/env bash
#
# HLLAPI 共有ライブラリをビルドする（Linux / macOS から。Windows 版も作れる）。
#
#   crates/hllapi/tools/build.sh                # そのホスト向け（.so / .dylib）
#   crates/hllapi/tools/build.sh --windows      # Windows 版 64bit ＋ 32bit も
#   crates/hllapi/tools/build.sh --windows-only
#   crates/hllapi/tools/build.sh --check-only   # ビルド済みのものを検査するだけ
#
# ## このスクリプトが要る理由
#
# クレート自体は `cargo build --release` だけで済むが、**環境が整っていないことが多い**:
#
# - C コンパイラが無いと `cc` がリンカとして呼べない（`rust-lld` に切り替える）
# - Windows 版には mingw の import ライブラリが要る（**root なしで取れる**）
# - **ビルドが通っても正しいとは限らない**——32bit が cdecl のままだと
#   VBA から呼んだ瞬間にスタックが壊れる。作った後で必ず検査する
#
# 環境を汚さないよう、**リポジトリには何も焼き込まない**（`.cargo/config.toml` を置かない）。
# 必要なものは実行時に環境変数で渡し、取ってきたものは `--cache-dir` の下に置く。
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$here/.."
cache="${TS5250_BUILD_CACHE:-${TMPDIR:-/tmp}/ts5250-hllapi-build}"
checker="$here/check-dll.py"

want_native=1
want_windows=0
check_only=0
for a in "$@"; do
  case "$a" in
    --windows) want_windows=1 ;;
    --windows-only) want_windows=1; want_native=0 ;;
    --check-only) check_only=1 ;;
    --cache-dir=*) cache="${a#*=}" ;;
    -h|--help) sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "不明な引数: $a" >&2; exit 2 ;;
  esac
done

say() { printf '\033[1m==> %s\033[0m\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }

# cargo は rustup 既定の場所にも居る（PATH に無い環境がある）
if ! have cargo && [ -x "$HOME/.cargo/bin/cargo" ]; then
  export PATH="$HOME/.cargo/bin:$PATH"
fi
have cargo || { echo "cargo がありません。https://rustup.rs から入れてください" >&2; exit 1; }

mkdir -p "$cache"
outputs=()

#-------------------------------------------------------------- ネイティブ
# C コンパイラが無い環境では `cc` をリンカに使えない。`rust-lld` へ切り替え、
# 実行時ライブラリへのシンボリックリンクを作って渡す（**リポジトリには残さない**）。
native_env() {
  if have cc || have gcc || have clang; then return; fi
  say "C コンパイラが無いので rust-lld でリンクします"
  local L="$cache/fakelib"
  mkdir -p "$L"
  local found=0
  for n in c m dl pthread rt util gcc_s; do
    local so
    so="$(ls /usr/lib/*/lib"$n".so.* /usr/lib/lib"$n".so.* 2>/dev/null | head -1 || true)"
    [ -n "$so" ] && { ln -sf "$so" "$L/lib$n.so"; found=1; }
  done
  [ "$found" = 1 ] || { echo "実行時ライブラリが見つかりません" >&2; exit 1; }
  export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER=rust-lld
  export RUSTFLAGS="${RUSTFLAGS:-} -L $L"
}

#-------------------------------------------------------------- Windows
# mingw の import ライブラリを探す。**無ければ root 無しで取ってくる**
# （`apt-get download` ＋ `dpkg -x`。Debian / Ubuntu 系のみ）。
mingw_root() {
  # $1 = ディレクトリの綴り（x86_64 / i686）、$2 = Debian パッケージの綴り（x86-64 / i686）。
  # **この 2 つは違う。** 下線とハイフンを取り違えると「パッケージが見つかりません」になる
  local arch="$1" pkg="$2"
  # 1. システムに入っていればそれを使う
  if [ -d "/usr/$arch-w64-mingw32/lib" ] && ls /usr/lib/gcc/"$arch"-w64-mingw32/*/libgcc.a >/dev/null 2>&1; then
    echo "/"; return
  fi
  # 2. 指定があればそれ
  if [ -n "${MINGW_ROOT:-}" ]; then echo "$MINGW_ROOT"; return; fi
  # 3. キャッシュ済み
  local root="$cache/mingw"
  if [ -d "$root/usr/$arch-w64-mingw32/lib" ] && ls "$root"/usr/lib/gcc/"$arch"-w64-mingw32/*/libgcc.a >/dev/null 2>&1; then
    echo "$root"; return
  fi
  # 4. 取ってくる（root は要らない。展開するだけ）
  have apt-get && have dpkg || {
    echo "mingw-w64 が要ります（apt: mingw-w64-$pkg-dev gcc-mingw-w64-$pkg-posix）" >&2
    echo "別の場所にあるなら MINGW_ROOT=<展開先> を指定してください" >&2
    exit 1
  }
  say "mingw-w64（$arch）を取得します（root は使いません）"
  mkdir -p "$root" "$cache/deb"
  ( cd "$cache/deb" && apt-get download "mingw-w64-$pkg-dev" "gcc-mingw-w64-$pkg-posix" >/dev/null )
  for d in "$cache/deb"/*"$pkg"[-_]*.deb; do dpkg -x "$d" "$root"; done
  echo "$root"
}

build_windows() {
  local target="$1" arch="$2" pkg="$3" linkvar="$4"
  rustup target list --installed 2>/dev/null | grep -qx "$target" || {
    say "rustup target add $target"
    rustup target add "$target"
  }
  local root gccdir
  root="$(mingw_root "$arch" "$pkg")"
  root="${root%/}"
  gccdir="$(ls -d "$root"/usr/lib/gcc/"$arch"-w64-mingw32/* | head -1)"
  say "ビルド: $target"
  # **`link-self-contained=yes` が要る。** 外部リンカを指定すると rustc が
  # crt2.o / dllcrt2.o を渡さなくなり、DllMainCRTStartup が未定義になる
  env "$linkvar=rust-lld" \
      RUSTFLAGS="-C link-self-contained=yes -L $root/usr/$arch-w64-mingw32/lib -L $gccdir" \
      cargo build --release --manifest-path "$crate/Cargo.toml" --target "$target"
  outputs+=("$crate/target/$target/release/ts5250hllapi.dll")
}

#-------------------------------------------------------------- 実行
if [ "$check_only" = 0 ]; then
  if [ "$want_native" = 1 ]; then
    ( native_env; say "ビルド: ネイティブ"
      cargo build --release --features selftest --manifest-path "$crate/Cargo.toml" )
  fi
  if [ "$want_windows" = 1 ]; then
    build_windows x86_64-pc-windows-gnu x86_64 x86-64 CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER
    build_windows i686-pc-windows-gnu   i686   i686   CARGO_TARGET_I686_PC_WINDOWS_GNU_LINKER
  fi
fi

if [ "$want_native" = 1 ]; then
  for f in "$crate"/target/release/libts5250hllapi.{so,dylib}; do
    [ -f "$f" ] && outputs+=("$f")
  done
fi
if [ "$check_only" = 1 ] && [ "$want_windows" = 1 ]; then
  for t in x86_64-pc-windows-gnu i686-pc-windows-gnu; do
    f="$crate/target/$t/release/ts5250hllapi.dll"
    [ -f "$f" ] && outputs+=("$f")
  done
fi

[ ${#outputs[@]} -gt 0 ] || { echo "出力がありません" >&2; exit 1; }

# **作った後で必ず検査する。** ビルドが通ったことは正しさの保証にならない
say "検査"
python3 "$checker" "${outputs[@]}"

say "出来上がり"
for f in "${outputs[@]}"; do printf '  %s\n' "$f"; done
