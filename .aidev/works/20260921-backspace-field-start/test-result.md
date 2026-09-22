# テスト結果: 欄の先頭の Backspace

## 実行したもの
- web-ui のキー操作・欄の編集に触れる 40 ファイル — 528 passed / 0 failed。型検査（test 込み）通過。
- 実機（ACS のコア・PUB400）: research F2（2 回）。
- 節目（マイルストーン 8）の独立点検への対応後: 全量 6,403 passed / 0 failed / 41 skipped・lint・build 通過。DBCS の欄の先頭の Backspace を ACS のコアで実測（社内機・DSM の試験画面 `DBCSBS`。測った後に消した）——O の欄・J の欄とも 0005。
  `field-boundary-backspace.test.ts` に DBCS の 2 件。mutation（DBCS の先頭で 0005 を出さない）検出。

## 受け入れ基準ごとの判定
- AC1: pass — 0005・値もフォーカスもそのまま・続けて打てない。
- AC2: pass — 途中の Backspace・中間区間の先頭は従来どおり。
- AC3: pass — mutation 2 通り（SBCS・行をまたぐ欄を旧い動きに戻す）。

## 失敗の証跡

```
$ npx vitest run test/continued-field-edit.test.ts test/screen-grid-focus.test.ts test/field-boundary-backspace.test.ts   # 実装を変えた直後
 × 先頭で押すと field-prev が出て、**値は変わらない**（ほか 5 件）
 Tests  6 failed | 12 passed (18)
```
旧い動き（前の欄の末尾へ移る）を固定していたテスト。ACS の実測に合わせ、取り消し線の注記つきで書き換えた。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-backspace-field-start
smoke: /healthz ok, / が Web UI を返した (port 44931)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- DBCS の欄（D2）。実ブラウザ。
