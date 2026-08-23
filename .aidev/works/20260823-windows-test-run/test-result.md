# テスト結果: Windows 実機でテスト一式が緑になった

## 実機

Windows 11 Pro build 10.0.26200.9168 / Node 24.18.0 / npm 11.16.0。
外部コマンドの在否: `unzip` **在り**（Git 同梱 6.00）/ `openssl` **在り**（3.5.7）/
`python3` **無し**（Store のアプリ実行エイリアスだけが在る）/ `lp` `lpstat` **無し**。

## 全体（`npm test`。**`develop` の上**＝#354 の次）

| workspace | 結果 |
|---|---|
| `@ts5250/base` | 52 passed |
| `@ts5250/ebcdic` | **99 passed**（うち 3 件はこの作業で直した） |
| `@ts5250/hostserver` | 991 passed |
| `@ts5250/scs` | 25 passed |
| `@ts5250/server` | **1,288 passed / 16 skipped**（0 failed） |
| `@ts5250/tn3270` | 254 passed / 38 skipped |
| `@ts5250/tn5250` | **485 passed**（うち 3 件はこの作業で直した） |
| `@ts5250/vt` | 185 passed |
| `@ts5250/web-ui` | **1,745 passed**（パッケージ dir から実行） |
| `@ts5250/gen-tables` | 10 passed |
| `npm run lint` | 緑（error 0） |
| `npm run build`（`tsc -b` ＋ web-ui の `vue-tsc`） | 緑 |

**failed 0。** 起点は「`packages/server` が 1,246 件中 11 件 failed」だった
（起点は**古い `main`** で測った値。着手時に古い main から分岐していたため。
件数の差は develop 側でテストが増えている分）。

## skip の内訳（**飛ばした事実を握り潰さない**）

`server` の 16 skipped は次の内訳。いずれも**この OS では成り立たない前提**か
**外部コマンドが無い**もので、Linux では従来どおり走る。

| 件数 | 何が飛んでいるか | 代わりに何が見ているか |
|---|---|---|
| 6 | `print-dest`（CUPS の宛先チェック。偽コマンドが `#!/bin/sh`） | Windows の印刷経路は `printer-output-windows.test.ts` |
| 5 | `zip-writer` の外部検証（`python3` が実際には走らない） | `unzip` を使う 4 件は**通っている** |
| 1 | `output-dir` の「書き込めないディレクトリー」（`chmod` が効かない） | — （Linux / macOS で見る） |
| 1 | `printer-output` の「`lp` 不在なら degrade」 | `printer-output-windows.test.ts` の win32 分岐 |
| 1 | `printer-output-windows` の「Windows 以外は lp へ」（非 Windows 用の対照） | Linux 側で見る |
| 2 | 既存の skip（この作業の前から） | — |

`tn3270` の 38 skipped は **TK4-（docker）が要る harness** で、この作業の対象外。

## 直したもの（skip ではなく修正）

| 対象 | 何が起きていたか | 検証 |
|---|---|---|
| `prebuilt-fresh.test.ts` | CRLF チェックアウトでソース木の sha256 が変わり「古い DLL」と誤判定 | `.gitattributes` ＋ 作業ツリー再正規化で**通った**（skip ではない） |
| `ebcdic` のガード 2 件 | パス区切りが `\` で比較が外れ、**表に到達していても通る**（fail-open） | 対照のテストが通るようになった＝ガードが効いている |
| `tn5250` の `tls.test.ts` 3 件 | `mktemp -d` が MSYS パス（`/tmp/tmp.x`）を返し Node が読めない | `mkdtempSync` に置換して 3 件とも通る |

## 空振り検証

| ミュータント | 結果 |
|---|---|
| `ebcdic` の正規化を外す（`replaceAll` を消す） | **死亡**（3 件が落ちる。実際に走らせて確認） |
| `.gitattributes` 無し・作業ツリーが CRLF | **死亡**——**この作業の起点がそれ**（`prebuilt-fresh` が sha256 不一致で落ちていた） |
| `python3` の判定が ENOENT だけ | **死亡**——同じく起点の実測（zip の 5 件が「在る」と誤判定して落ちていた） |

下の 2 つは**変更前の状態がそのままミュータント**なので、改めて壊し直してはいない
（起点の失敗は `20260823-pccmd-windows-verify` の test-result にも数字で残っている）。

## 未検証の穴

- **Linux 側は回していない**（この機械に無い）。変更は `skipIf(win32)` の追加と
  パスの正規化・`mkdtempSync` への置換に限り、**Linux の経路に条件を足していない**
  ——`skipIf(win32)` は Linux では従来どおり走る。CI（Linux）で確認されるべき
- **`.gitattributes` は他の作業ツリーにも効く**。既存の登録内容は変えていないので
  `git status` は clean のままだが、Windows で作業している人の手元は
  次のチェックアウトで LF になる（意図した変更）
- **Windows を CI で回してはいない**（backlog に残した）
