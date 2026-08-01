# 仕様: ebcdic 再輸出の撤去

## 0. 着手前ベースライン（2026-08-01）

270 files / 3,269 tests（skip は `zip-writer` の 4 件）。
web-ui 本番バンドル JS **359,857 バイト**。

## 1. 削除する再輸出（24 名前）

| 場所 | ブロック |
|---|---|
| `tn5250/src/index.ts` | 文字変換（`SbcsCodec` / `codecForCcsid` / `katakanaChar` / `SO` / `SI` ほか 10） |
| 〃 | 純 DBCS（`PureDbcsCodec` / `pureDbcsCodecForCcsid` / `isPureDbcsCcsid` / `ibm300` / `ibm16684`） |
| 〃 | CCSID テキスト（`decodeCcsidText` / `TEXT_CCSIDS` / `ccsidLabel` ほか 9） |
| `tn5250/src/browser.ts` | `TEXT_CCSIDS` / `ccsidLabel` / `LineEnding`（catalog）、`katakanaChar` / `latinChar`（katakana） |

**`import` は消さない**——`screen/` `protocol/` `session/` が内部で使うのは正当。
消すのは `export … from "@as400web/ebcdic…"` の形だけ。

## 2. web-ui の付け替え（6 ファイル）—— 狭い入口を維持する

| ファイル | 名前 | 新しい入口 |
|---|---|---|
| `components/IfsPane.vue` | `TEXT_CCSIDS` / `ccsidLabel` | `@as400web/ebcdic/catalog` |
| `ifsApi.ts` / `composables/usePreview.ts` | `LineEnding` | `@as400web/ebcdic/catalog` |
| `components/ScreenGrid.vue` / `screenExport.ts` | `katakanaChar` / `latinChar` | `@as400web/ebcdic/katakana` |
| `test/host-code-pages.test.ts` | `codecForCcsid` | `@as400web/ebcdic/codec` |

**バレル（`@as400web/ebcdic`）に向けてはならない**——変換表 18,900 行が丸ごと入る。
`packages/web-ui/package.json` の `dependencies` に `@as400web/ebcdic` を追加する。

## 3. ガードの作り直し

`tn5250/test/codec-reexport.test.ts` は「再輸出が到達可能なこと」を検査していたので、
撤去で意味が反転する。**`ebcdic-not-reexported.test.ts` へ `git mv` して中身を逆にする**
（名前が意味と食い違ったまま残ると、次に読む人が逆の期待をする。#235 と同じ判断）。

| # | 検査 | 落ちる状況 |
|---|---|---|
| 1 | `import * as tn5250` に ebcdic の export 名が 1 つも無い | 再輸出を戻した |
| 2 | `tn5250/src` に `export … from "@as400web/ebcdic"` が 0 件 | 同上（ソース側） |
| 3 | **web-ui がバレルを import していない**（`/catalog` `/katakana` `/codec` のみ） | 狭い入口を外した＝表が戻る |
| 4 | web-ui の `dependencies` に `@as400web/ebcdic` がある | 宣言漏れ |

**#3 が本命**。#237 で scs のバレルに向けてバンドルが 4 倍になった失敗を、
今度は**入口の指定そのもの**を検査して塞ぐ。

## 4. 受け入れ基準

requirement のとおり。とくに **web-ui バンドル 359,857 バイト以下**と
**`ibm-1399` / `ibm-37` / `ibm-273` が 0 件**。
