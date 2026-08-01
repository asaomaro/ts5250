# 検証結果（test 工程・2026-08-01）

`spec.md`「3.」の受け入れ基準を実測。**全項目充足**。

## 1. 3c —— 型のみの依存を web-ui へ移す

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 1 | `packages/core/package.json` の `dependencies` に hostserver が無い | `base` / `ebcdic` / `scs` の 3 つのみ | ✅ |
| 2 | `packages/core/tsconfig.json` の `references` に `../hostserver` が無い | `../base` / `../ebcdic` / `../scs` のみ | ✅ |
| 3 | `packages/core/src` の hostserver 参照が 0 件（コメント除く） | **0 件** | ✅ |
| 4 | web-ui の `devDependencies` に hostserver（`dependencies` には無い） | `devDependencies` にのみ存在 | ✅ |
| 5 | web-ui 本番バンドル JS ≤ 359,853 バイト | **359,853 バイト（完全一致）** | ✅ |
| 6 | バンドルに `node:net` / `node:tls` が 0 件 | **0 件** | ✅ |
| — | バンドルに `hostserver` の文字列が 0 件 | **0 件**（`import type` が消えている実証） | ✅ |
| 7 | ガードから `browser.ts` の例外が消えている | 例外なしの「0 件」に強化＋宣言の検査を 2 件追加 | ✅ |

CSS も 89,097 バイトで一致（ファイル名のハッシュは JS チャンク名に連動して変わる）。

## 2. 3d —— 旧名の置換

**32 ファイル / 78 箇所**を `Tn5250Error` → `As400Error` に置換。

| 場所 | ファイル |
|---|---|
| `packages/hostserver/test` | 20 |
| `tools/hostserver-check/src` | 8 |
| `packages/core/test`（`buffer` / `gds` / `tls` / `transport`） | 4 |

**残した 5 ファイル（意図的）** — 走査で確認済み:

```
packages/base/src/errors.ts:2          別名の定義そのもの
packages/base/src/index.ts:1           base の公開面
packages/core/src/index.ts:1           公開 API の後方互換
packages/core/test/codec-reexport.test.ts:1   改名の経緯を述べたコメント
packages/core/test/errors-compat.test.ts:7    新旧の同一性を検査するテスト
```

`errors-compat.test.ts` が緑＝**旧名は引き続き外から取れる**（外部利用者の互換は壊していない）。

## 3. 共通

| package | 着手前 | 着手後 |
|---|---|---|
| `@as400web/base` | 1 / 8 | 1 / 8 |
| `@as400web/ebcdic` | 8 / 83 | 8 / 83 |
| `@as400web/scs` | 1 / 13 | 1 / 13 |
| `@as400web/hostserver` | 42 / 643 | 42 / 643 |
| `@as400web/core` | 49 / 455 | 49 / **457** |
| `@as400web/server` | 60 / 805 | 60 / 805 |
| `@as400web/web-ui` | 107 / 1,249 | 107 / 1,249 |
| `@as400web/gen-tables` | 1 / 10 | 1 / 10 |
| **合計** | **269 / 3,266** | **269 / 3,268**（+2） |

+2 は `hostserver-not-reexported.test.ts` に足した宣言検査 2 件。失敗 0。
skip は `zip-writer.test.ts` の 4 件のみ（`unzip` 未インストール。既知）。

`npm run build`（`tsc -b`）・`npm run build -w @as400web/web-ui`（`vue-tsc` ＋ `vite build`）・
`npx eslint packages tools` いずれも成功。

## 4. ガードが実際に効くことの確認

| 壊し方 | 結果 |
|---|---|
| `packages/core/package.json` の `dependencies` に hostserver を戻した | **FAIL**「package.json / tsconfig.json のどちらにも hostserver の宣言が無い」 |

確認後に復元し、7 件緑を再確認。

## 5. coding 中に捕まえた問題 2 件

1. **root の `tsc -b` は web-ui を見ていない**（decisions.md D5）。`browser.ts` の再輸出を
   消したあと root のビルドは緑のままで、`vue-tsc` が
   `packages/web-ui/test/use-ifs-tree.test.ts` を落とした。web-ui は root の
   project references に無く、しかも `tsconfig.test.json` で **test も型検査の対象**。
   → 該当 1 ファイルを修正
2. **`dist` を読む検査がコメントに引っかかった**（decisions.md D6）。`tsc` は JSDoc を
   出力に残すので、`browser.ts` に書いた「hostserver をここへ戻すな」という注意書き自体が
   検出された。→ `readDist()` でコメントを剥がしてから検査するようにした

## 6. 未検証の穴

- **実機（IBM i）での動作確認は未実施。** 3d は同一クラスの別名置換、3c は型の import 元変更で
  実装ロジックには触れていないが、`tools/hostserver-check` が実機診断ツールなので
  機会があれば一度走らせたい
- `zip-writer.test.ts` の 4 件は `unzip` 未インストールのため skip のまま
- CI が無いため、上記はいずれも自動では埋まらない
