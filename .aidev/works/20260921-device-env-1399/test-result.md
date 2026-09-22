# テスト結果: 1399 の申告

## 実行したもの
- base `test/device-env.test.ts` 5 passed・tn5250 `test/terminal-wide.test.ts` 11 passed（KBDTYPE・1399 に触れる tn5250 のテスト 129 件のうち、写しの期待値 1 件を直した）・tn3270 `test/ibmi-structured-field.test.ts` 16 passed
- 実機: `scripts/verify-device-env.mjs PUB400 1399`・`AS400 1399` — どちらも pass=2（サインオン・日本語の往復）。`verify-3270-devname.mjs`（1399）の節 1 — 両方で繋がった。
  VT（PUB400。1399 と 37）— どちらもサインオン画面が出た。ACS のワイヤ: research F3
- 全量・lint・build は節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 値の固定と ACS のワイヤ（1399・939・930・37）。
- AC2: pass — 上の実機。

## 失敗の証跡

```
$ npx vitest run $(grep -ln "1399\|KBDTYPE\|kbdType" test/*.ts)   # tn5250。表を変えた直後
 FAIL  test/terminal-wide.test.ts > deviceEnvFor: CCSID → RFC 2877 デバイス属性 > 日本語 DBCS は SBCS 部を申告する（930=カタカナ 290 / 939・1399=英小文字 1027）
      Tests  1 failed | 128 passed (129)
```
旧い値を固定していた写し（base のテストが「値の固定は 1 か所」と書く一方で tn5250 にも残っていた）。新しい値に直した。
タップで採る途中、`pgrep -f` が自分のシェルに当たって手順が止まり、古いタップが 2424 番に残った（スレッド名で表に出ていて `comm` の絞り込みに掛からなかった）。
残ったタップを止め、引数で絞り直して採り直した。記録は消した。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45583)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 新しい値で装置の CHRID が ACS と同じになったかを DSPDEVD で並べてはいない（申告のバイト列が ACS と同じことまで）。
