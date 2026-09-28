# テスト結果: WDSF のマイナー構造体の否定応答

## 実行したもの
- `cd packages/tn5250 && npx tsc --noEmit -p .` — OK
- `cd packages/tn5250 && npx vitest run` — 1233 passed / 0 failed
- 変異 27 通り（初回実装分 24 通り＋独立点検で足した修正 3 通り）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass — `packages/tn5250/test/wtd-order-sense.test.ts`「WDSF のマイナー構造体の否定応答」（29 件。選択肢文字列・選択肢の属性・
  メニューバーの区切り・スクロール・バー付き選択欄の外側ゲート・窓の枠・表題脚注・罫線の型/位置/反復/間隔・複数マイナーの歩き）

## 失敗の証跡
このラウンドでは差し戻しになる失敗は発生していない。独立点検（review 工程で `taskcheck cross` として実施）で 2 件の should を見つけ、その場で直した
（`review.md` のタスク点検ログ参照）。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 41115)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実機（DSM）は未検証**。原典（デコンパイル済み ACS のコア）の直読だけで実装した（decisions D2）。台帳の「WDSF の中の否定応答（残り）」に、
  次に着手する人への申し送りとして残す
- 選択肢の属性の値・0x54 の CCSID 形・構造体そのものが画面の外（0x10050112）・罫線の反復/間隔つき矩形の総延長は対象外のまま
