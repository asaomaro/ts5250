# 設計

## 概要
- 打鍵の文字を `rejectReason` に通す前に `spaceToFullWidth(f, ch)` で変換する。J（`only`）・G（`pure`）は常に U+3000。E（`either`）は編集中の値に全角の字があるときだけ U+3000。O・SBCS は変えない。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`、`packages/web-ui/test/dbcs-space-key.test.ts`。

## 依拠する既存の事実
- `onDbcsKeydown` は `inputChar` の後に `rejectReason`・`dbcsType`（欄の型ごとの入力）を通す（`ScreenGrid.vue`）。`edit.chars` は編集中の論理値。`isFullWidth`。

## インターフェース / データ構造
- `spaceToFullWidth(f: Field, ch: string): string`（内部関数）。

## 振る舞いの詳細
- 空白（U+0020）だけを変換する。貼り付け・IME の確定は変えない。

## エラー処理 / 異常系
- 変換後の U+3000 は全角として `rejectReason` を通るので、J・G では拒否されない。

## 受け入れ基準との対応
- AC1〜AC3: 4 件のテスト（J・G・E の 3 状態・O）。AC4: mutation 7 通り。
