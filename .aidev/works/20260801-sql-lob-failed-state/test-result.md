# 検証結果: LOB の未取得理由に `failed` を足す

実施 2026-08-01（UTC）。実機は使わない（spec のとおり、プロトコルの新規解釈を含まないため）。

## 全体

| 検証 | 結果 |
|---|---|
| `npm run build`（`tsc -b`） | **通過**（exit 0） |
| `npm test`（全ワークスペース） | **3,283 件すべて通過 / 失敗 0 / skip 0** |
| `npm run lint`（リポジトリ全体） | **落ちる（本 work の外。下記「既知の制約」）** |
| 変更 7 ファイルへの `npx eslint` | **エラー 0** |

ワークスペース別の内訳（`npm test`）:
`base 41` / `ebcdic 83` / `scs 648` / `tools/gen-tables 10` / `hostserver 805` /
`tn5250 415` / `server 25` / `web-ui 1,256`。

**skip は 0 件**——環境不足で飛ばした検証は無い。

### テストが空振りでないことの実測（deliver 前）

実装の 4 か所（catch の値・ログレベル・画面の分岐・CSV の分岐）を**元に戻して**測った。

| 戻した範囲 | 落ちた件数 |
|---|---|
| catch の値のみ（`failed` → `not-requested`） | hostserver 3 |
| ＋ログレベル（`warn` → `debug`） | hostserver 4 |
| ＋画面と CSV の分岐 | web-ui 4 |
| **合計** | **8 件** |

測定後は元に戻し、`npm test` の再実行で全件通過を確認した。
新規 12 件のうち残る 4 件は**変更が無くても通る**——`not-requested` / 取得済み / RFC 4180 の
エスケープ / ロケーター保持など、**既存挙動を固定する側**のテスト（回帰の網であって本件の証拠ではない）。

## 受け入れ基準ごとの検証

### 1. 型に `"failed"` が含まれる — 合格

`packages/hostserver/src/db/db-decode.ts:50`

```ts
unavailable?: "not-requested" | "too-large" | "failed";
```

ビルド成果物（`dist/db/db-decode.d.ts:33`）にも同じ union が出ている＝
web-ui が `import type` する側にも届く形になっている。

### 2. 失敗時に `unavailable` が `"failed"` — 合格（新規 5 件）

`packages/hostserver/test/lob-fill-failure.test.ts`

| ケース | 何を固定したか |
|---|---|
| 取りに行って失敗したら `failed` | `not-requested` に混ぜない（本件の中核） |
| ロケーターと `maxSize` は残す | 取り直す手がかりを消さない。`value` / `byteLength` は付かない |
| 1 セルの失敗で残りを捨てない | 行内の他セル・後続の行も処理する。LOB でない値には触らない |
| 例外の型は問わない | 素の `Error`（通信断相当）でも `failed`。型を絞ると貫通してクエリ全体が落ちる |
| **失敗理由は `warn` で出る** | `setLogSink` で捕まえ、`warn` 1 件・ロケーターと例外本文の両方が読めることを確認 |

最後の 1 件は **test 工程で追加**した。画面が「サーバーのログに理由が出ます」と案内する以上、
`debug` のままなら既定の sink で消えて**案内が嘘になる**（decisions D3）。
コードを読むだけでは「上げたつもり」を検出できないので、レベルごと固定した。

### 3. 失敗セルに「左のチェックで取得」が出ない — 合格（新規 2 件）

`packages/web-ui/test/sql-pane.test.ts`

- `failed` のセル本文が `(LOB: 取得失敗)`
- ツールチップが「左のチェックで取得」を**含まず**、「失敗」を含む

### 4. CSV で `not-requested` と区別でき、空欄でない — 合格（新規 5 件）

`packages/web-ui/test/csv.test.ts`（**変更前は LOB の網羅がゼロだった**）

| 状態 | CSV |
|---|---|
| 取得済み | 中身（`,` を含めば RFC 4180 でクォート） |
| `not-requested` | `(LOB)` |
| `failed` | `(LOB: 取得失敗)` |

「どの状態でも空欄にしない」を NULL と並べた 1 行で固定した
（`N,A,B` → `,(LOB),(LOB: 取得失敗)`）。空欄は SQL の NULL と混ざる。

### 5. 既存挙動が変わらない — 合格

- 既存テストは**1 件も変更していない**。`sql-pane.test.ts:350` の `not-requested` の
  ツールチップ検査（「取得していません」を含む）はそのまま通っている
- `too-large` / 取得成功の分岐は触っていない
- リポジトリ全体 3,283 件が通過（変更前から増えたのは新規 12 件）

### 6. 取りこぼしが無いことの確認（grep による横断）

`unavailable` を**書く**箇所と**読む**箇所を全リポジトリで数え直した。

- 書く: `db-decode.ts:119`（初期値 `not-requested`＝まだ要求していない。**正しい**）/
  `query.ts:462`（`too-large`）/ `query.ts:471`（`failed`）の 3 か所のみ
- 読む: `SqlResultTable.vue`（`lobText` / `lobTitle`）と `csv.ts`（`escapeField`）のみ。
  **いずれも本 work で `failed` を足した**
- `packages/server`・MCP・electron に LOB 固有の整形は無い（spec「対象範囲」で確認済み）

→ **失敗時に `not-requested` を書く経路は残っていない。**

### 7. backlog の消し込み — deliver 工程で行う（未実施）

`.aidev/backlog/hostserver.md:341`。`aidev verify` が deliver 前に強制する。

## 既知の制約（deliver へ引き継ぐ）

- **`npm run lint` はリポジトリ全体では落ちる**。エラー 6 件はすべて**未追跡の
  `scripts/*.mjs`**（`build-empsfl` / `shot-buttons` / `shot-crt` /
  `shot-empsfl` / `shot-fkey` / `shot-font`）の `no-unused-vars` で、
  **本 work の着手前から作業ツリーにあった**別件の実機調査スクリプト。
  コミットしないので、**コミット対象の木は lint 清潔**（変更 7 ファイルを名指しで掛けてエラー 0）。
  詳細は decisions D4。
- **実機（IBM i）での確認は行っていない**。LOB 取得の失敗を実機で誘発する必要があり、
  かつ本変更は「catch がどの値を書くか」だけでプロトコルの解釈を変えない。
  backlog に残る「BLOB（バイナリ）と中身のある DBCLOB での検証」は**別項目**のまま。
- **古いクライアントへの後方互換はコード読解で判断**した（実行では確かめていない）。
  変更前の `lobText` / `lobTitle` / `escapeField` は `unavailable` を**等値比較しかしていない**ので、
  未知の `failed` が届いても分岐が既定側へ落ちるだけで例外にならない。
