# 検証結果（test 工程・2026-08-01）

`spec.md`「5. 受け入れ基準」を上から実測した。**12 項目すべて充足**。

## 1. 主目的 —— 実行時の辺が消えたか

| 対象 | 着手前 | 着手後 |
|---|---|---|
| **`packages/core/dist/index.js` の `@as400web/hostserver`** | **33 箇所** | **0 箇所** ✅ |
| `packages/core/dist/browser.js` の同 | 0 箇所 | **0 箇所**（維持）✅ |
| `packages/core/src/index.ts` の同 | 39 文 | **0 件** ✅ |
| `packages/core/src` 全体の同 | — | `browser.ts` の **`export type` 3 箇所のみ** ✅ |

**これが本作業の的**。`@as400web/core` を import してもホストサーバーの実装は
実行時に読み込まれなくなった。`core → hostserver` は**型のみ**の辺として残る（意図どおり。decisions.md D2/D5）。

## 2. 利用側の移設

| 場所 | ファイル | 書き換えた import 文 |
|---|---|---|
| `packages/server/src` | 31 | — |
| `packages/server/test` | 16 | — |
| `tools/hostserver-check/src` | 11 | — |
| **合計** | **58** | **61** |

宛先の内訳: `@as400web/base` 46 文 / `@as400web/hostserver` 37 文 /
`@as400web/core`（残る）15 文 / `@as400web/scs` 3 文 / `@as400web/ebcdic` 3 文。

**名前を落としていないことを機械的に確認した**——書き換えの前後で
「各ファイルが `@as400web/*` から取っているローカル名の集合」を出力して `diff` を取り、
**差分ゼロ**（78 ファイル分）。別名（`childLog as coreChildLog`）と `type` 修飾も保たれている。

`package.json` / `tsconfig.json` の宣言も追加済み:

- `packages/server` → base / ebcdic / hostserver / scs を `dependencies` と `references` に
- `tools/hostserver-check` → base / ebcdic / hostserver を同様に

## 3. ビルド・テスト・lint

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 6 | `npm run build`（`tsc -b`） | 成功 | ✅ |
| 7 | テスト件数が減っていない | 下表 | ✅ |
| 8 | `npx eslint packages tools` | exit 0 | ✅ |

| package | 着手前 | 着手後 |
|---|---|---|
| `@as400web/base` | 1 / 8 | 1 / 8 |
| `@as400web/ebcdic` | 8 / 83 | 8 / 83 |
| `@as400web/scs` | 1 / 13 | 1 / 13 |
| `@as400web/hostserver` | 42 / 643 | 42 / 643 |
| `@as400web/core` | 49 / 456 | 49 / **455** |
| `@as400web/server` | 59 / 801 | **60** / **804** |
| `@as400web/web-ui` | 107 / 1,249 | 107 / 1,249 |
| `@as400web/gen-tables` | 1 / 10 | 1 / 10 |
| **合計** | **268 / 3,263** | **269 / 3,265**（+2） |

**core が 1 件減っているが、カバレッジは落ちていない**（decisions.md D8）——
`hostserver-reexport.test.ts`（6 件）を `hostserver-not-reexported.test.ts`（5 件）に
作り直したため。旧 6 件のうち「主要な入口が使える」は hostserver 自身のテストが見ており、
「package.json が hostserver に依存」は `browser.ts` の型検査が壊れることで `tsc` が捕まえる。
新 5 件は代わりに**ビルド成果物 2 つ**を検査しており、旧版に無かった強度がある。

失敗は 0。skip は `zip-writer.test.ts` の 4 件のみ（`unzip` 未インストール。PR #234 で
ハード失敗から skip に変えた既知の環境要因）。

## 4. 後方互換

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 9 | `packages/web-ui` の追跡ファイル差分 | **空** | ✅ |
| 10 | web-ui 本番バンドル JS | **359,853 バイト（前後で完全一致）** | ✅ |
| — | 同 CSS | 89,097 バイト（一致） | ✅ |

web-ui は 1 行も変えずに動く。`@as400web/core/browser` の型のみ再輸出を残したので、
`IfsEntry` などの型は従来どおり解決できる。

## 5. ガードテストが実際に効くことの確認

**わざと壊して落ちることを確認**してから戻した。

| ガード | 壊し方 | 結果 |
|---|---|---|
| `core/test/hostserver-not-reexported.test.ts` | `index.ts` に `export { DbConnection } from "@as400web/hostserver";` を 1 行戻した | **3 件 FAIL**（バレル到達／src 走査／`dist/index.js`）。**`tsc -b` は通った**——型検査では捕まらないことの実証 |
| `server/test/import-from-owner.test.ts` | `host-sql.ts` の `As400Error` の取得元を `@as400web/base` → `@as400web/core` に戻した | **FAIL**「`host-sql.ts: As400Error は @as400web/base のもの`」 |

いずれも確認後に復元し、緑を再確認（`git diff` で復元を検証）。

## 6. coding からの差し戻し

**1 回発生した**（`test.md` ではなく実装中に検知・修正。decisions.md D7）。

plan では「分類走査で移し残しを 0 にしてから撤去する」としたが、**撤去後に 6 件のテストが落ちた**。
走査が見ていたのは `import { … } from "@as400web/core"` の名前だけで、次の 2 つは形が違った。

1. `packages/core/test/log-sink-single-instance.test.ts` が `insertRows` を core のバレルから
   取っていた（**走査の対象ディレクトリに core 自身のテストが入っていなかった**）
2. `packages/server/test/host-spools.test.ts` が
   `vi.spyOn(await import("@as400web/core"), "listSpooledFiles")` でモックしていた
   （**import 文ではないので走査に映らない**。被験側が hostserver から取るようになったため、
   **モックしたつもりで実物が動く**状態だった）

どちらもテストが落ちて気づけた。**型検査では気づけなかった**のが重要な点。

## 7. 未検証の穴

- **実機（IBM i）での動作確認は未実施。** import 元の付け替えと再輸出の削除のみで、
  実装ロジックには一切触れていないが、`packages/server` の 31 ファイルが対象なので
  実機を通す機会があれば signon / SQL / IFS / スプールを一度確認したい
- `zip-writer.test.ts` の 4 件は `unzip` 未インストールのため skip のまま
- CI が無いため、上記はいずれも自動では埋まらない
