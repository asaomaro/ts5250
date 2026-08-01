# 検証結果（test 工程・2026-08-01）

`spec.md`「7. 受け入れ基準」を上から順に実測した。**12 項目すべて充足**。

## 1. 構造（切り出せていること）

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 1 | `packages/core/src/hostserver` と移動した `transport/` 2 ファイルが存在しない | `core/src/transport/` に残るのは `tcp.ts` / `types.ts` のみ | ✅ |
| 2 | `packages/hostserver` の `dependencies` が 3 つだけ | `["@as400web/base","@as400web/ebcdic","@as400web/scs"]` | ✅ |
| 3 | `packages/base` に `dependencies` が無い | `undefined` | ✅ |
| 4 | hostserver → `@as400web/core` の import が 0 件 | **0 件**（`@as400web/core` の文字列は 5 箇所あるがすべて JSDoc / コメント。import 指定子としては 0） | ✅ |
| 5 | hostserver → `protocol`/`screen`/`session`/`telnet`/`trace` が 0 件 | 0 件 | ✅ |

`packages/hostserver/src` の外部指定子の全量（これが切り出しの結果そのもの）:

```
51  @as400web/base
16  @as400web/ebcdic
 1  @as400web/scs
 2  node:net      ← src/transport/ のみ
 2  node:tls      ← src/transport/ のみ
```

## 2. ビルド・テスト・lint

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 6 | `npm run build`（`tsc -b`）が成功 | 成功（無出力） | ✅ |
| 7 | テスト件数がベースライン以上・失敗は既知の 4 件のみ | 下表 | ✅ |
| 8 | lint が成功 | `npx eslint packages tools` が exit 0 | ✅ |

### テスト件数（分割前 → 分割後）

| package | files（前→後） | tests（前→後） |
|---|---|---|
| `@as400web/base` | –（新設） → **1** | – → **8** |
| `@as400web/ebcdic` | 8 → 8 | 83 → 83 |
| `@as400web/scs` | 1 → 1 | 13 → 13 |
| `@as400web/hostserver` | –（新設） → **42** | – → **643** |
| `@as400web/core` | 89 → 49 | 1,092 → 456 |
| `@as400web/server` | 59 → 59 | 801 → 801 |
| `@as400web/web-ui` | 107 → 107 | 1,249 → 1,249 |
| `@as400web/gen-tables` | 1 → 1 | 10 → 10 |
| **合計** | **265 → 268**（+3） | **3,248 → 3,263**（+15） |

**1 件も減っていない。** 増分 +15 の内訳は新設・拡張したガードテストのみ:

- `hostserver/test/no-core-dependency.test.ts` +5（新設）
- `core/test/hostserver-reexport.test.ts` +6（新設）
- `core/test/log-sink-single-instance.test.ts` +2（新設）
- `core/test/errors-compat.test.ts` +2（既存を拡張）

**失敗は `packages/server/test/zip-writer.test.ts` の 4 件のみ**で、これは
`spawnSync unzip ENOENT`＝この devcontainer に `unzip` が無いことによる環境要因。
**分割前から同じ 4 件が落ちている**（`spec.md`「0.」に記録済み）。本作業とは無関係。

> `npm run lint` そのものは失敗する。ただし原因は**未追跡の調査用スクリプト 6 本**
> （`scripts/build-empsfl.mjs` ほか。`git ls-files` に無い）の未使用変数で、
> **本作業の前から存在し、変更もしていない**。追跡対象である `packages` と `tools` に
> 限定すると exit 0 で通る。

## 3. 後方互換

| # | 基準 | 実測 | 判定 |
|---|---|---|---|
| 9 | `packages/server` / `packages/web-ui` / `tools/hostserver-check` の diff が空 | **追跡ファイルの変更 0 件**（`git status --short` が空） | ✅ |
| 10 | web-ui 本番バンドル JS ≤ 359,853 バイト | **359,853 バイト（前後で完全一致）** | ✅ |
| 11 | バンドルに `node:net` / `node:tls` が現れない | `grep -c` = **0** | ✅ |
| 12 | `tools/hostserver-check` がビルドできる | 成功 | ✅ |

**#9 がこの作業の中心。** 利用側 59 ファイル（server 37 ＋ web-ui 22）＋ `tools/hostserver-check` を
**1 行も変えずに** 10,743 行を別パッケージへ移せた。CSS も 89,097 バイトで前後一致。

バンドルの module 数は 167 → 169 に増えた（`@as400web/base` の `index.ts` と `identifier.ts` が
モジュール境界として現れるため）が、**バイト数は 1 バイトも変わっていない**。

## 4. ガードテストが実際に効くことの確認

「足したが効いていないテスト」を残さないため、**わざと壊して落ちることを確認**してから戻した。

| ガード | 壊し方 | 結果 |
|---|---|---|
| `log-sink-single-instance.test.ts` | `hostserver/src/log-dup.ts` に `log.ts` を複製し、`db/insert.ts` をそちらへ向けた | **FAIL**「hostserver 側のログが差し込んだ出力先へ届いていない」。**このとき `tsc -b` は通った**——型検査では捕まらないことの実証でもある |
| `no-core-dependency.test.ts` | `hostserver/src/return-codes.ts` に `import type { ScreenSnapshot } from "@as400web/core"` を足した | **FAIL**「expected [ 'return-codes.ts' ] to deeply equal []」 |
| `hostserver-reexport.test.ts` | `core/src/index.ts` から `listJobs` の再輸出行を消した | **FAIL**「expected [ 'listJobs' ] to deeply equal []」 |

いずれも確認後に元へ戻し、緑を再確認済み（`git diff` で復元を検証）。

3 つ目は設計を 1 度直している——最初は `index.ts` から export 名を読み取って到達可能性だけを
見ていたが、それでは**行ごと消されたときに検査対象からも消えて緑のまま**になる。
`@as400web/hostserver` 自身の公開面と突き合わせる検査を足して、削除も捕まえられるようにした。

## 5. 差し戻しなし

test 工程での失敗は 0 件のため coding への差し戻しは発生していない。
