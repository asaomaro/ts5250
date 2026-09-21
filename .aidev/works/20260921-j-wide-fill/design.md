# 設計

## 概要
- `wideFill(f)`（J＝`only`・G＝`pure`）を足し、`padDbcs` の詰め物を全角空白に、`trimPad` の落とす末尾を全角空白も含めるのをこの 2 種にする（G だけだったものを J へ広げる）。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`、`packages/web-ui/test/dbcs-pure-field.test.ts`、`dbcs-insert-room.test.ts`（J の期待値の更新）。

## 依拠する既存の事実
- J の予算は SO/SI 込み（12 バイト＝SO ＋ 5 スロット ＋ SI）。全角空白で詰めると 5 スロットを埋め、欄の桁数は変わらない。

## インターフェース / データ構造
- `wideFill(f: Field | undefined): boolean`（内部）。

## 振る舞いの詳細
- J の編集値は末尾の全角空白・半角空白を落として送る（比較にも同じ）。途中の全角空白は値のまま。

## エラー処理 / 異常系
- 詰め物の残りが 1 バイトのときだけ半角空白（欄長は偶数なので通常は来ない）。

## 受け入れ基準との対応
- AC1〜AC3: `dbcs-pure-field.test.ts` の J の 3 件と、E・O の既存テスト。mutation 5 通り。
