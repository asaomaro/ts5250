# レビュー記録

## ラウンド 1（2026-08-01T08:54:17Z）

差分 7 ファイル（実装 4・テスト 3）を requirement / spec / AGENTS.md の観点で点検した。

### 確認して問題なしだったもの

- **要件適合**: requirement の完了条件 6 件（deliver 分を除く）すべてに対応する実装とテストがある
- **MCP の出力スキーマを壊さない**: `host_sql` の `outputSchema` は
  `rows: z.array(z.record(z.string(), z.unknown()))`（`host-server-tools.ts:151`）で
  値を制約していない。**`failed` を足しても zod 検証は落ちない**
- **分岐の順序**: `lobText` / `escapeField` はどちらも「値が文字列なら先に返す」を保っている。
  `failed` の判定を前に置いていたら、部分値を持つ状態（`too-large`）で値を捨てていた
- **`fillLobs` の export が公開面を広げていない**: `packages/hostserver/src/index.ts` は
  `query.js` からの export を列挙しており（42-47 行）、`fillLobs` は入っていない
- **`not-requested` の初期値は正しいまま**: `db-decode.ts:119` の `decodeValue` は
  「まだ要求していない」状態を作る箇所なので `not-requested` のままでよい
- **規約適合**: ログは `childLog` の sink 経由（`console.*` を使わない）。新規 import なし。
  コメントは why 中心で、判断の出所（spec D1 / decisions D3）を明記している

### 指摘

- [should] `README.md:383-385` — **利用者向けドキュメントが新しい表示に触れていない**。
  この節は LOB セルが `(LOB)` と表示されることを名指しで書いている。今回
  `(LOB: 取得失敗)` という**新しい表示**が出るようになったのに、README は無言のまま。
  本 work の趣旨は「LOB の状態について利用者を誤解させない」ことなので、
  画面だけ直してドキュメントを黙らせるのは同じ種類の穴を残す。
  1〜2 行で「取得を有効にしても失敗した場合は `(LOB: 取得失敗)` と出る」を足す。
  / 対応: **差し戻し（coding）**

- [nit] `packages/hostserver/test/lob-fill-failure.test.ts` — ログ検査が
  `seen.filter(warn).toHaveLength(1)` ＋ `seen[0].level === "warn"` の 2 段になっているが、
  これでは**ログが 1 件だけ**であることを固定できていない（warn 1 件＋debug 1 件でも通る）。
  `expect(seen).toHaveLength(1)` の方が強く、かつ短い。
  / 対応: **差し戻しに同梱して修正**

- [nit] `packages/web-ui/src/components/SqlPane.vue:8` — `isLob` を import しているが
  **どこからも使っていない**（テンプレートにも無い）。**本 work の変更前から**の死んだ import。
  1 語の削除だが、焦点の合った差分を保つため本 PR には含めない。
  / 対応: **許容（follow-up）**

- [nit] `packages/web-ui/src/csv.ts:20-26` — CSV は `too-large` を無印で出すため、
  **打ち切られた LOB が完全な値のように見える**（画面は `…（以降省略）` を付ける）。
  **本 work の変更前から**の食い違いで、spec D5 で意図的に対象外にした。
  / 対応: **許容（follow-up）**

- [nit] `packages/web-ui/src/csv.ts:22-25` — 同じ分岐の中で、`v` は
  `(value as { value?: unknown }).value` とキャストする一方、`unavailable` は
  型ガードで絞られた `value.unavailable` を直接読んでいる。`isLob` の宣言する
  `value?: string` が実態（`string | Uint8Array`）と食い違っているのが原因の**既存の歪み**で、
  今回はそれに合わせず正しく書ける側を正しく書いた形。ガードの型定義を実態に合わせるのが本筋。
  / 対応: **許容（follow-up）**

### 判定

**must 0 / should 1 / nit 4** → should があるため **coding へ差し戻す**。

差し戻しで扱うのは should 1 件と nit 1 件（テストの締め）。残る nit 3 件はいずれも
**本 work の変更前から存在する**もので、直すと差分の焦点がぼやけるため follow-up とする。

---

## ラウンド 2（2026-08-01T08:57:18Z）

ラウンド 1 の差し戻し 2 件の反映を確認した。

- **should（README）**: `README.md:386-390` に追記した。**打ち切り（`(LOB: 大きすぎます)`）にも
  併せて触れた**——既に存在していたのに書かれておらず、失敗だけ足すと歯抜けになるため。
  これで利用者が見る 3 つの表示（未取得 / 打ち切り / 失敗）が README で揃った。
  CSV の区別と「空欄にしない」理由、失敗理由の出どころ（サーバーのログ `warn`）も明記した
- **nit（テストの締め）**: `expect(seen).toHaveLength(1)` に置き換えた。
  **ログが 1 件だけ**であることを固定したので、warn 1 件＋debug 1 件では通らなくなった

### 再検証（実行結果）

- `npm run build`（`tsc -b`）: 通過（exit 0）
- `npm test`: **3,283 件通過 / 失敗 0**
  （`base 41` / `ebcdic 83` / `scs 648` / `server 25` / `hostserver 805` / `tn5250 415` /
  `web-ui 1,256` / `tools/gen-tables 10`）
- 変更した実装ファイルへの `npx eslint`: エラー 0

### 指摘

**なし**（must 0 / should 0 / nit 0）。

ラウンド 1 の nit 3 件は follow-up として据え置く——`SqlPane.vue` の未使用 import・
CSV が `too-large` を無印で出すこと・`isLob` の型宣言が実態と食い違うこと。
**いずれも本 work の変更前から存在**し、直すと本 PR の焦点がぼやける。

### 判定

**通過**（次工程: deliver）。

