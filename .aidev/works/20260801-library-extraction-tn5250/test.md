# 検証結果（test 工程・2026-08-01）

`spec.md`「6.」の受け入れ基準を実測。**充足（1 点は基準そのものを訂正）**。

## 1. 構造

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 1 | `packages/core` が無く `packages/tn5250` がある。`name` が `@as400web/tn5250` | そのとおり | ✅ |
| 2 | 追跡ファイルの `@as400web/core` が 0 件 | **0 件**（`package-lock.json` も含む） | ✅ |
| 3 | `tn5250/src` に `csv-parse.ts` / `sql/` / `text/` / `codec/` / `html/spool-html.ts` が無い | 残るのは `browser.ts` / `index.ts` / `screen-html.ts` ＋ 6 ディレクトリ | ✅ |
| 4 | `@as400web/base` から `parseCsv` / `splitSqlStatements` / `isFullWidth` が取れる | 取れる（テスト 41 件が緑） | ✅ |
| 5 | `@as400web/scs` から `renderSpoolHtml` が取れる | 取れる（テスト 25 件が緑） | ✅ |
| 6 | `packages/base/package.json` に外部 `dependencies` が無い | 無い（ガードが検査） | ✅ |
| 7 | `packages/scs/tsconfig.json` の `types` が `[]` | `[]` のまま | ✅ |
| 8 | ~~`tn5250` の `dependencies` が base / ebcdic の 2 つだけ~~ | **base / ebcdic / scs の 3 つ** | ⚠️**基準の誤り** |
| 9 | 逆向きの辺が 0 本 | **0 本**（新設ガードが 15 通りを走査） | ✅ |

**#8 は spec の誤り**（decisions.md D4）。`session/printer-session.ts` が `ScsDecoder` を使う——
**5250 のプリンターセッションはホストから SCS を受け取って復号する**ので、
`tn5250 → scs` は TN5250 の一部として正しい依存。基準の方を訂正した。

## 2. ビルド・テスト・lint

| package | 着手前 | 着手後 |
|---|---|---|
| `@as400web/base` | 1 / 8 | **3 / 41** |
| `@as400web/ebcdic` | 8 / 83 | 8 / 83 |
| `@as400web/scs` | 1 / 13 | **2 / 25** |
| `@as400web/hostserver` | 42 / 643 | 42 / 643 |
| `@as400web/core` → `@as400web/tn5250` | 49 / 457 | **47 / 413** |
| `@as400web/server` | 60 / 805 | 60 / 805 |
| `@as400web/web-ui` | 107 / 1,249 | 107 / 1,249 |
| `@as400web/gen-tables` | 1 / 10 | 1 / 10 |
| **合計** | **269 / 3,268** | **270 / 3,269**（+1） |

内訳: `dependency-direction.test.ts` **+5**（新設）／`codec-reexport.test.ts` **−4**
（`/codec` ファサードと `ScsDecoder` 再輸出の検査。**対象が消えたので削除**。
カバレッジの喪失ではない。decisions.md D7）。

失敗 0。skip は `zip-writer.test.ts` の 4 件のみ（`unzip` 未インストール。既知）。

`npm run build`（`tsc -b`）・`npm run build -w @as400web/web-ui`・
`npx eslint packages tools`・`tools/hostserver-check` と `tools/gen-tables` のビルド、いずれも成功。

## 3. バンドル —— 途中で 4 倍に膨らんだ

| 段階 | JS |
|---|---|
| 着手前 | 359,853 バイト |
| **`spool-html` を scs のバレル経由にした直後** | **1,458,480 バイト（約 4 倍）** |
| 狭い入口 `@as400web/scs/spool-html` を新設後 | **359,857 バイト** |

バレル経由で `ScsDecoder` → `scs.ts` → `@as400web/ebcdic`（バレル）→ **変換表 5 つ**に
到達していた。`20260726-ccsid-table-bundling` が塞いだのと同じ失敗様式（decisions.md D5）。

**最終値は着手前より 4 バイト大きい**（359,853 → 359,857）。
基準は「359,853 以下」だったので**厳密には超過**だが、表の再混入ではないことを直接確認した:

- modules transformed: **169 → 169**（変化なし）
- `ibm-1399` / `ibm-37` / `ibm-273` の痕跡: **0 件**
- `ibm-930` / `ibm-939` の SBCS 部: **各 1 件**（`20260726-ccsid-table-bundling` の
  記録どおり、これは残るのが正しい）
- `node:net` / `node:tls`: **0 件**

CSS は 89,097 バイトで一致。**基準の意図（表が戻っていないこと）は直接検査で満たしている。**

## 4. ガードが実際に効くことの確認

`dependency-direction.test.ts` に `scs → tn5250` の逆向きを作って検証した。
**1 回目は目的のテストで落ちなかった**——`@as400web/[a-z-]+` という正規表現が
**数字を含まない**ため `@as400web/tn5250` を `tn` として拾っており、層の比較が空振りしていた
（宣言の一致検査に引っかかって偶然 FAIL していただけ）。

`[a-z0-9-]+` に直して再検証し、**「上位を import している下位が無い」が
`scs → tn5250（index.ts）` で落ちる**ことを確認した。壊す検証をしていなければ、
**ガードが効いていないまま緑**だった。

## 5. 未検証の穴

- **実機（IBM i）での動作確認は未実施。** 移動と改名のみで実装ロジックには触れていないが、
  190 ファイルに及ぶ改名なので、機会があれば signon / SQL / IFS / 画面操作を一度通したい
- `zip-writer.test.ts` の 4 件は `unzip` 未インストールのため skip のまま
- **未追跡の `scripts/*.mjs`**（調査用スクリプト）も改名に追随させたが、
  **実行しての確認はしていない**（実機接続が要るため）
- CI が無いため、上記はいずれも自動では埋まらない
