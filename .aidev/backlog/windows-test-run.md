# Windows 実機でテストを回す

2026-08-23 に **Windows 11 実機でテスト一式を初めて全部緑にした**
（起票 `20260823-pccmd-windows-verify` / PR #355 → 片づけ `20260823-windows-test-run` / PR #356）。
落ちていたものは**すべてテスト側の前提**で、製品の不具合は 1 件も無かった。

## 回すのに要ること（この順で潰す）

| 手 | やらないとどうなるか |
|---|---|
| `npm install` | workspace が `node_modules` に張られておらず、**27 ファイルが collect 段階で落ちる**（`Cannot find package '@ts5250/vt'`） |
| `npx tsc -b` | `packages/vt/dist` が無い＝**同じ 27 ファイルが落ちる**（張ってあっても未ビルドだと解決できない） |
| **チェックアウトが LF** | `.gitattributes`（`* text=auto eol=lf`）で担保した。下の「指紋」の項目を参照 |

## 実測（Windows 11 Pro build 26200.9168 / Node 24.18.0）

| 段階 | 結果 |
|---|---|
| 整える前 | 27 ファイルが collect 失敗 |
| 整えた直後 | `packages/server` **1,243 件中 12 件 failed** |
| PC コマンドの回帰を入れた後 | 1,246 件中 11 件 failed（新規 3 件が緑・`test -d .` を 1 件直した） |
| **この作業のあと** | **全 workspace 緑**: base 52 / ebcdic 83 / hostserver 972 / scs 25 / **server 1,230 passed ＋ 16 skipped** / tn3270 254＋38 skipped / tn5250 468 / vt 185 / web-ui 1,742 / gen-tables 10。`npm run lint` ・ `npm run build`（vue-tsc 込み）も緑 |

## 片づけたもの

- [x] `output-dir.test.ts`「書き込めないディレクトリは「書き込めません」」
  - **Windows の `chmod` にはディレクトリーの書き込みを止める力が無い**（実体は ACL）。
    `0o500` を渡しても書けるので判定が反転する。root と同じ扱いで skip（`cannotDenyWrite`）
- [x] `print-dest.test.ts`（suite ごと skip）
  - 偽コマンドが `#!/bin/sh`（拡張子なし）で **Windows では実行できない**。
    6 件のうち 4 件が別の理由でたまたま通り 2 件が落ちる、という当てにならない状態だった。
    `checkPrintDest` が見ているのは CUPS（`lp` / `lpstat`）で、
    **Windows の自動印刷は別経路**（`printer-output.ts` の win32 分岐）なので走らせる意味が無い
- [x] `printer-output.test.ts`「autoPrint は lp 不在なら warn」
  - Windows は `lp` を通らない。同じ degrade は `printer-output-windows.test.ts` が見ている
- [x] `printer-output-windows.test.ts`「**Windows 以外は**従来どおり lp へ」
  - 名前のとおり非 Windows 専用（対照）。Windows 実機では前提が反転するので skip
- [x] `zip-writer.test.ts` 5 件（`python3` の検出）
  - **Microsoft Store の「アプリ実行エイリアス」**（`…\WindowsApps\python3.exe`）が
    既定で置かれており、**起動できるので ENOENT にならない**が、走らせると
    「Python was not found」で失敗する。`python3 -c pass` の終了コードで見るようにした
    （`unzip` は Git 同梱のものが動くので判定はそのまま）
- [x] `prebuilt-fresh.test.ts`「ソースを変えたら作り直されている」＋ **`.gitattributes` を新設**
  - **DLL は古くなかった。** `core.autocrlf=true` の Windows チェックアウトで
    `.rs` / `Cargo.toml` / `Cargo.lock` が CRLF になり、`manifest.json` の sha256
    （LF で取った指紋）と食い違っていた
  - `* text=auto eol=lf` で**作業ツリーをどの OS でも同一バイト**にした。
    バイト指紋の検査はそれを前提にしている（`start.bat` を LF で保つ既存方針とも揃う）
  - **原典 `tools/gen-tables/ucm/*.ucm` は `-text`** で除外（Unicode.org 由来。
    3 ファイルは CRLF で登録済みで、変換すると生成物の裏取りが原典と一致しなくなる）

## この作業で**新たに見つかった**もの（いずれも片づけた）

- [x] `packages/ebcdic` の到達可能性ガード 2 件が **Windows で fail-open していた**
  - `catalog-no-tables.test.ts` / `katakana-no-dbcs.test.ts` は `path` の相対化結果を
    `startsWith("tables/")` や `/tables\/ibm\d+\.ts$/` で見ていた。**Windows では `\` になり、
    表に到達していても「していない」と判定する**——バンドルサイズを守るガードが
    黙って素通しする状態だった（対照のテストが落ちて気づけた。**対照を書いておいた設計の勝ち**）
  - 相対パスを `/` に正規化して修正
- [x] `packages/tn5250` の `tls.test.ts` 3 件
  - `mktemp -d` が Git 同梱のもので **MSYS のパス**（`/tmp/tmp.xxxx`）を返し、
    Node からは `C:\tmp\…` として解決されて読み書きできなかった。`mkdtempSync` に置換
  - 併せて `openssl` の有無で suite を skip できるようにした（無い環境では
    「TLS が壊れた」ではなく「検証手段が無い」が正しい）

## 方針: CI は置かない（2026-08-23 の判断）

**Windows を CI で回す案は採らない**（利用者の判断）。このリポジトリに CI は無く
（`.github/` そのものが無い）、Windows 固有の経路の確認は**人が実機で回す**ことで担保する。
起票し直す前にこの節を読むこと。

そのため次の 2 点は運用で気をつける:

- **回すのは人の手**。Windows 固有の経路（`cmd.exe` 経由の PC コマンド・印刷・
  PDF フォント探索）の退行は、誰かが Windows で `npm test` を回すまで見つからない
- **skip の実数**（server 16 / tn3270 38）は飛ばした事実として vitest の出力に残る。
  「緑だから検証された」と読み違えないこと（`unzip` / `python3` / `openssl` を
  入れれば skip は減る）
