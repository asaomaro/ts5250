# テスト結果: 死んだ桁を AID のあとも残す

## 実行したもの
- 後述の全体テスト・lint・型検査、実機（ブラウザ）`verify-browser-cont-o-dead-kept.mjs` pass=4 fail=0（E1・E2 のバイト列とカーソル）
- 変異 5 通り（snapshot の `dead`・死んだ桁のセル・`cellAt`・`dbcsRawCell`・web-ui の読み戻し）— 全て検出

## 受け入れ基準ごとの判定
- AC1: pass — `o-chain-send.test.ts`
- AC2: pass — 実機 E1・E2、`o-chain-edit.test.ts`

## 失敗の証跡
このラウンドでは失敗が発生していない（修正前の走行は取っていない。変異検査で代替した）。

## 起動確認（smoke）
smoke: pass

## 未検証の穴（skip / 環境不足）
- 実機の修正前の走行（不一致の証跡）は取っていない
