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

## 節目 9 の対応（ラウンド 2 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,474 passed / 0 failed / 41 skipped
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（1 回目は `ScreenGrid` の `ccsid` の prop 型で落ち、`number | undefined` に直した）
- mutation（`scratchpad/mut-m9.py` 25 通り＋`mut-m9b.py` 4 通り）— 生き残った 3 通り（DBCS の打鍵・ペースト・IME の MDT）にテストを足して全部 KILLED

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 46429)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 受け入れ基準の再確認
- AC1〜AC4: pass（全量）。加えて DBCS の先頭・打ち直し（打鍵・DBCS の打鍵・ペースト・IME）・継続欄の MDT を `field-exit-checks-mdt.test.ts`（11 件）で固定

### 失敗の証跡
点検役の再現（直す前の HEAD。`scratchpad/rv5/web/dbcs-exit.test.ts` / `me-same.test.ts` / `me-pure.test.ts`）:

```
[dbcs-exit ME・MDT あり] notices=["入力が必要な項目です（入力してから、先頭以外の位置で項目を出てください）"] edits=[] field-full=0
[dbcs-exit MF・部分入力・MDT あり] notices=[] edits=[""] field-full=1
[me-same] notices=["入力が必要な項目です（…）"] edits=[] field-full=0
[me-pure] cont seg2 (caret not at start, seg1 edited): mandatory-enter
```

直した後に足したテストの 1 回目は、テストの側（ScreenGrid 単体で親が `edits` を更新しない）で落ちた。親の役（`onEdit` で Map に入れる）を足して通った:

```
FAIL  test/field-exit-checks-mdt.test.ts > 字を置けば値が変わらなくても MDT（ACS `inputChar` の `setMDT`） > ホストの値 AB の ME 欄の先頭に A を打ち直して Field Exit → 止めない（編集も出る）
AssertionError: expected [ Array(1) ] to not include '入力が必要な項目です（入力してから、先頭以外の位置で項目を出てください）'
      Tests  1 failed | 7 passed (8)
```
