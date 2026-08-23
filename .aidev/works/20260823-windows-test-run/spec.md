# 仕様: 落ちている前提を 3 通りに分けて処置する

落ち方は 3 種類しかない。**種類ごとに処置を決め、個別に判断しない**
（個別に決めると「なぜ skip なのか」が読めなくなる）。

| 種類 | 処置 | 対象 |
|---|---|---|
| **A. その OS では成り立たない前提** | `skipIf` で飛ばし、**代わりに何が見ているか**をコメントで指す | `output-dir`（`chmod` が効かない）/ `print-dest`（`#!/bin/sh` の偽コマンド）/ `printer-output`（`lp` を通らない）/ `printer-output-windows`（非 Windows 用の対照） |
| **B. 検出が間違っている** | 検出を直す（飛ばす前に「在るか」を正しく測る） | `zip-writer` の `python3`（Store のエイリアスで ENOENT にならない）/ `tls` の `openssl`（有無で skip できるようにする） |
| **C. OS 差でテスト自身が壊れている** | **直す**（skip にしない。壊れているのはテストの書き方） | `ebcdic` の到達可能性ガード（`\` で比較が外れる）/ `tls` の `mktemp`（MSYS パス）/ `prebuilt-fresh`（CRLF で指紋が変わる） |

## S1: `.gitattributes` を新設する（C の 1 件）

```
* text=auto eol=lf
tools/gen-tables/ucm/*.ucm -text
```

- **なぜ**: 同梱 DLL の鮮度検査はソース木の sha256 を突き合わせる。
  `core.autocrlf=true` の Windows チェックアウトでは中身が同じでもバイトが変わり、
  **「古い DLL が配られている」と誤判定する**。バイト指紋の検査は
  「作業ツリーが同一バイト」を前提にしているので、そこを宣言で固める
- **`.ucm` を除く理由**: Unicode.org 由来の原典で、3 ファイルは CRLF で登録済み。
  変換すると生成物の裏取りが原典と一致しなくなる
- **既存の登録内容は変えない**（index は既に LF。`-text` の 3 ファイルもそのまま）。
  変わるのは**チェックアウト時のバイト**だけ
- バイナリは `text=auto` の自動判定に任せず**明示する**（`*.dll` / 画像 / フォント等）

## S2: fail-open しているガードを直す（C の 1 件・**最も重い発見**）

`packages/ebcdic` の `catalog-no-tables.test.ts` / `katakana-no-dbcs.test.ts` は
「バンドルに変換表が混ざらないこと」を到達可能性で固定するガードだが、
相対パスの区切りが Windows では `\` になるため
**`startsWith("tables/")` が常に false**——表に到達していても気づけない。
相対化の結果を `/` に正規化する。

**skip にしてはならない**。これは OS 差でテストが壊れている例で、
飛ばすと Windows では永久にガードが働かない。

## S3: 検出の直し（B）

- `zip-writer`: `python3 -c pass` の**終了コード**で判定する。
  「`-h` の扱いはコマンドごとに違うので ENOENT だけを見る」という既存の方針は
  そのまま（`unzip` は動くので触らない）——**python だけは実際に走らせる**
- `tls`: `openssl version` の ENOENT で suite を skip できるようにする

## S4: skip の書き方（A）

`it.skipIf(process.platform === "win32")` / `describe.skipIf(...)` を使い、
**理由と「代わりに何が見ているか」を必ず併記する**。
`print-dest` は 6 件のうち 4 件が別の理由でたまたま通っていたので、**suite ごと**飛ばす。

## 受け入れ基準

- [ ] `npm test`（全 workspace）・`npm run lint`・`npm run build` が Windows で緑
- [ ] `.gitattributes` 適用後に `git status` が clean（登録内容が変わっていない）
- [ ] `prebuilt-fresh` が**通る**（skip ではなく）
- [ ] ebcdic のガードが Windows で**実際に効く**（対照のテストが通る）
