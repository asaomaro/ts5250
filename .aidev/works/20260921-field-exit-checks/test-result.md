# テスト結果: Field Exit・Field± の前の検査

## 実行したもの
- web-ui: `field-exit-checks.test.ts`（新規 6 件）と `mandatory-check-acs`・`aid-field-exit-required`・`ffw-behavior-bits` — 88 passed / 0 failed。`vue-tsc`（test 込み）通過。
- 実機（社内機・ACS のコア）: `scripts/acs-probe/field-exit-checks.txt`（research F2）。1 回目は入力不可の欄の行を取り違えた（`Y` の欄がコンパイルで落ちて並びが 1 つずれていた）ので、画面を見て 15 行目に直して測り直した。
- mutation 10 通りすべて検出（`scratchpad/mut-fec.py`）。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 入力不可の欄で Field Exit が止まる（欄を出ない）。
- AC2: pass — 先頭で Field Exit・打ってから先頭で Field+ が止まる、打ってそのまま Field Exit は次の欄。純ロジックで MDT なし。
- AC3: pass — 先頭以外で部分入力の MF は消さずに先頭へ戻して止める。
- AC4: pass — 上の mutation。

## 失敗の証跡

```
$ npx vitest run test/field-exit-checks.test.ts   # 最初の版
 × **打ってから先頭へ戻って Field+ → 止まる**（実機の E4）
AssertionError: expected '' to be '入力が必要な項目です（入力してから、先頭以外の位置で項目を出てください）'
```
テストの書き誤り（先頭へ戻るのに Home を押していた。Home は画面のホーム位置へ移るので欄の外へ出ていた）。左矢印 2 回に直した。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- MF の Field Exit を ACS のコアで測っていない（原典と単体まで）。実ブラウザ。
