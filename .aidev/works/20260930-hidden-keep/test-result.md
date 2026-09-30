# テスト結果: 触らない桁の目印

## 実行したもの
- 後述の全体テスト・lint・型検査
- 実機（ブラウザ）: `verify-browser-hidden-dbcs.mjs` pass=6（O・J・E の上書きと Delete）、either-remainder 4・space-typed 12・je-field 3・o-field 3・cont-o 24 — 全て fail=0
- 変異 7 通り — 全て検出

## 受け入れ基準ごとの判定
- AC1: pass — 実機 6 の比較・`hidden-keep.test.ts`・`wide-nul.test.ts`
- AC2: pass — `hidden-keep.test.ts`（snapshot の字は空白のまま・`keep` だけ）

## 失敗の証跡
このラウンドでは失敗が発生していない（修正前の走行は取っていない。修正前の挙動は「空から始まる」ことをコードで確認した）。

## 起動確認（smoke）
smoke: pass

## 未検証の穴（skip / 環境不足）
- 伏せ字の欄の選択範囲の削除・貼り付け・語の削除は ACS を測っていない
