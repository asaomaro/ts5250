# レビュー記録

## ラウンド 1（2026-07-27T03:12:24Z）

生成物（表 11 ファイル）・`package-lock.json`・`.aidev` を除いた実装差分 10 ファイル。
要件適合・正確性・規約適合（AGENTS.md）・保守性の 4 観点で点検した。

### 要件適合・正確性（問題なし）

- 受け入れ基準 11 項目は test 工程で全数検証済み。バンドルは
  **1,407,469 → 305,643 バイト（−1,101,826）**、数値トークンは 187,881 → 2,063
- `katakanaChar` は全 256 バイトで分割前と一致。4 経路
  （`@as400web/core` / `/codec` / `/browser` / `@as400web/ebcdic/katakana`）から取れ、
  **すべて同一実体**であることを実解決で確認
- `codecForCcsid(930)` の DBCS デコード・純 DBCS(16684) とも従来どおり動作
- `packages/server/src` の差分ゼロ。`gen:tables` は冪等
- 生成器の**振り分けロジック（flag による方向規則）は 1 行も変わっていない**。
  出力の分け方だけが変わったことを差分で確認した
- 分割後の 3 モジュールすべてに出典表記（ICU / Unicode License V3）が付いている
- `browser.ts` に足した経路は `katakana.ts → tables/ibm930-sbcs.ts → table-types.ts` のみで、
  `node:*` にも I/O にも触れない＝`browser.ts` の定義（冒頭コメント）を満たす

### 指摘

- [should] `packages/core/src/codec/codec.ts:10` — **コメントが事実と食い違うようになった**。
  互換ファサードの JSDoc に「ここを消したり `exports` を書き換えたりすると既存の利用側が黙って壊れる」
  として `packages/web-ui/src/components/ScreenGrid.vue — katakanaChar` を挙げているが、
  **web-ui はこの経路を使わなくなった**（`@as400web/core/browser` に移した）。
  AGENTS.md の「コメントは why を書く」に照らすと、**誤った根拠が残るのが最も害が大きい**——
  読んだ人が「web-ui のために `/codec` を維持している」と信じてしまう。
  実際に残す理由は `packages/server/src/host-dtaq.ts` の 1 箇所と、前作業で確立した後方互換。
  / 対応: 差し戻し

- [should] `packages/core/test/codec-reexport.test.ts:40,93` — **同じ理由で古くなった**。
  ヘッダの利用者一覧が `/codec` の欄に web-ui を挙げ、
  テスト名も「（web-ui の ScreenGrid.vue が使う）」となっている。
  テスト自体は後方互換の検査として今も有効（**無変更で通ることを確認済み**＝
  受け入れ基準「`codec-reexport.test.ts` が無変更で通る」は満たしている）だが、
  **根拠の記述だけが古い**。／ 対応: 差し戻し

- [nit] `AGENTS.md:17` — コメント規約の**例示が古くなった**。
  「落とし穴・非自明な判断を明文化する」の例として
  `// codec サブパスからブラウザ安全に import（root は pino/node 依存を巻き込むため不可）`
  を挙げているが、(1) web-ui はもう codec サブパスを使わない、
  (2) `pino` は `20260719-core-debt-payoff` で core から server へ移っており、
  **この作業より前から `pino/` の部分は既に不正確**だった
  （root が巻き込むのは `transport/` の `node:net` / `node:tls`）。
  規約書に載る例が事実と違うのは、コード中のコメントより波及が広い。／ 対応: 差し戻し

- [nit] `packages/ebcdic/test/catalog-no-tables.test.ts:70-86` — 対照アサーションが
  表 11 ファイルの**完全な列挙**になっており、今後 CCSID を足すたびに更新が要る。
  ただしこれは「構造が変わったら気づく」という意図した設計で、実際に今回
  分割を検知して落ちた（それで期待値を更新した）。**維持する**。／ 対応: 許容

## ラウンド 2（2026-07-27T03:16:22Z）

ラウンド 1 の指摘 4 件の対応を確認した。

### 対応の確認

- [should] `packages/core/src/codec/codec.ts` — 利用者一覧から web-ui を外し、
  **ブラウザからこの入口を使わない理由**（DBCS 表込みで約 1.1 MB 引き込む）と
  正しい経路（`@as400web/core/browser`）を書いた／ **修正済**
- [should] `packages/core/test/codec-reexport.test.ts` — ヘッダの利用者一覧で
  `ScreenGrid.vue` を `/codec` から `/browser` の欄へ移し、
  テスト名を「後方互換。現在の利用側は無い」に改めた。
  **テストの検査内容は変えていない**（後方互換の担保はそのまま）／ **修正済**
- [nit] `AGENTS.md:17` — 例示を現状に合わせ、`katakanaChar` の入口選択の例を 1 行足した／ **修正済**
- [nit] `catalog-no-tables.test.ts` の完全列挙 — 意図した設計として**維持**（許容）

### ラウンド 2 の指摘

- [nit] `packages/core/src/browser.ts:6` — ラウンド 1 の AGENTS.md 修正で
  **相互参照が古くなった**（「AGENTS.md の codec サブパスと同じ理由」）。
  併せて、この JSDoc の「`log.js`(pino)」も **この作業より前から不正確**だった
  （pino は `20260719-core-debt-payoff` で server へ移動済み）。
  参照を現在の AGENTS.md の記述に合わせ、pino の経緯を注記し、
  「純粋でも重いものはある」というサイズの観点を足した／ **本ラウンドで修正済**

### 再検証

- クリーンビルド `tsc -b` ／ `npx eslint packages tools`：成功
- `npm test`：2,377 passed / 4 failed（`zip-writer.test.ts` の環境要因のみ）
- web-ui：`vue-tsc` 込みでビルド成功、バンドル **305,643 バイト**（`index-Bjet7KV1.js`）
- `packages/server/src` 差分ゼロ ／ `gen:tables` 差分なし

**判定: must 0 / should 0 / nit 1（本ラウンドで修正済）。review 通過。**
