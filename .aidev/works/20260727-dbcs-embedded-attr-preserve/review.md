# レビュー記録

## ラウンド 1（2026-07-27T10:14:11Z）

実装差分 4 ファイル（core 2 / web-ui 2）＋テスト 2 ファイル。計 67 行。

### 要件適合・正確性（問題なし）

- 受け入れ基準 11 項目を検証済み。**修正前に落ちるテスト**を先に書き、
  core / web-ui それぞれ修正を戻して**落ちることを再確認**した（4 件 / 4 件）
- **回帰の砦**（DBCS 構造つき未編集欄の送信バイト）は修正の前後とも通る＝
  `dbcsRawFieldValue` 経路に影響していない
- `rawByte` の既存利用箇所を**全数確認**した。web-ui は `kind === "sbcs"`、
  core は `type === "char"` で守られており属性セルと混ざらない。
  `save-screen.ts` は**内部セル**（`type === "attr"` を先に分岐）を使うので影響なし
- `fieldValue` の `dbcs` 変数は表示できない SBCS バイトの分岐でまだ使われている（未使用化していない）
- web-ui バンドル 306.03 → 306.17 kB（+140 バイト）。`fieldValidate.ts` に
  `@as400web/core/browser` の実行時 import が増えたが、既に同じバンドルに載っている入口

### 指摘

- [must] `ScreenGrid.vue` の `attrSentinel(cell.rawByte ?? 0)` — **既定値 0 が誤り**。
  属性センチネルの範囲は 0x20–0x3F で、`attrSentinel(0)` は U+E000＝
  `isAttrSentinel` が偽・`isRawSentinel` が真。つまり書き戻し（`setFieldValue`）で
  **属性セルではなく生バイトセルとして書かれ、属性が静かに失われる**。
  本作業で snapshot が必ず `rawByte` を載せるので現状は到達しないが、
  フォールバックが「安全側に壊れる」形になっていないのは良くない。
  既定を **0x20（通常・緑）** に変更した。／ **修正済**

- [nit] `dbcsByteLength` と `displayCols`（PR #172）が同種の問題を別々に持つ。
  共通化しない判断は `decisions.md` D3 に記録済み（桁数と送信バイト数は別概念）。／ 対応: 許容

### 再検証

- `npm run build`（クリーンから）／ `npx eslint packages tools`：成功
- core 811 件 ／ web-ui 905 件 ／ 全 workspace 2,391 passed / 4 failed（既知の環境要因）
- `npm run build -w @as400web/web-ui`（`vue-tsc` 込み）：成功

**判定: must 0（1 件を本ラウンドで修正）／ should 0 ／ nit 1（許容）。review 通過。**
