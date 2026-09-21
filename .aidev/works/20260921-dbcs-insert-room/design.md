# 設計

## 概要
- `absorbDbcs` に `wideBlank`（J・G・E で true）を足し、末尾の U+3000 も削れるようにする。`atLastColumn(e, f)`（G 以外。列ビューの位置が最終桁）を足し、挿入モードでカーソルが最終桁なら `dbcsType` が undefined（0012）を返す。
- 選択を置き換える挿入（`replaced`）には最終桁の判定を掛けない（消した跡を埋めるだけ。ACS の GUI の選択置換は未測定なので、従来の挙動を変えない）。
- 貼り付けの繰り返しの中で挿入が拒否されたら 0012 の通知を出す（事前の検査は欄全体の余地だけを見るので、最終桁の拒否がすり抜ける）。

## 対象範囲
- `packages/web-ui/src/components/ScreenGrid.vue`、`packages/web-ui/test/dbcs-insert-room.test.ts`、`scripts/acs-probe/dbcs-insert-room.txt`。

## 依拠する既存の事実
- `dbcsViewLayout` の `caretOf`・`columnsBefore`（列ビュー上の位置。`ScreenGrid.vue` の `dbcsLayoutOf`）。`visLen(f)`（欄の桁数）。SBCS の欄の同じ判定は `fieldEdit.insertChar` にある。

## インターフェース / データ構造
- `absorbDbcs(chars, budget, cursor, wideBlank = false)`・`atLastColumn(e, f)`・`dbcsType(e, ch, f, replaced = false)`（内部関数）。

## 振る舞いの詳細
- 空きに数えるのは J・G・E の末尾の U+3000。O は数えない。最終桁は `columnsBefore(caretOf(cursor)) >= visLen(f) - 1`。G は対象外（カーソルが 2 桁の前半にしか止まらない）。

## エラー処理 / 異常系
- 入らないときは値を変えず、通知 `MSG_NO_ROOM`（0012）。上書きには掛けない。

## 受け入れ基準との対応
- AC1〜AC3: `dbcs-insert-room.test.ts` の 19 件（J・E・O・貼り付け・IME・選択置換）。AC4: mutation 13 通り。
