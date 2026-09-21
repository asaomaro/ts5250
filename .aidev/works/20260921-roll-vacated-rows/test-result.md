# テスト結果: ROLL

## 実行したもの
- `test/screen-roll.test.ts` 12 passed。tn5250 の型検査。
- 実機（社内機）: 修正前の当 PJ・ACS のコア（`acs-probe/roll-vacated-{up,down}.txt`）・修正後の当 PJ を同じ試験プログラムで。
  修正後 `scripts/verify-roll.mjs` **pass=4 fail=0**。試験プログラムと IFS のファイルは消した（CHKOBJ で無いことを確認）。
- 節目（マイルストーン 8）の独立点検への対応（注記の訂正だけ）後: 全量 6,403 passed / 0 failed / 41 skipped・lint・build 通過。

## 受け入れ基準ごとの判定
- AC1: pass — 単体と実機（上下とも ACS と同じ画面）。
- AC2: pass — 単体（上端 0・下端が画面の外・逆・1 行・行数が範囲を超える／ちょうど）。
- AC3: pass — mutation 4 通り（上端 0・画面の外・空いた行を消す・行数の境界）。最初の「行数の境界」は等価な書き換えだったので、境界をずらして当て直した。

## 失敗の証跡

```
（修正前の当 PJ・上ロール） 01| ROW 01 02| ROW 05 … 17| ROW 20  21| ROW 21 …   ← 18〜20 行が空白
（ACS のコア・上ロール）    … 17| ROW 20 18| ROW 18 19| ROW 19 20| ROW 20 21| ROW 21 …
```
旧い動きを固定していたテスト 6 件（下端に空行ができる・範囲を超える送りは範囲を空にする ほか）は、実測に合わせて取り消し線の注記つきで書き換えた。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-roll-vacated-rows
smoke: /healthz ok, / が Web UI を返した (port 45275)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 不正な ROLL の実機（DSM は不正な引数を API 側で断る——`CPFA315`——ので、端末へ届かない）。負応答は未対応（D2）。
