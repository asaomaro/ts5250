# テスト結果: IME の余りを次の欄へ流す

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（IME・DBCS・挿入・画面に触れる web-ui のテスト 9 ファイル）— 259 passed / 0 failed / 0 skipped（`ime-flow-next-field.test.ts` の 9 件を足した）
- mutation（`scratchpad/mut-imf.py`）— 8 通りのうち 5 通り落ちた（余りを流さない・SBCS の上書きの末尾で止まらない・1 欄の画面で続ける・次の欄の 2 桁目から・2 つ先まで流さない）。
  生き残った 3 つは等価変異（保護欄のチェックは、ペインが保護欄へフォーカスを移さないので届かない防御／`prev` の更新順／挿入の 0012 で余りを返しても、`field-full` を出さないのでフォーカスが移らず流れない）
- 実機: 該当なし（ACS の GUI 層の IME は headless のコアで測れない）
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — SBCS（3 桁へ 5 字→次の欄に 2 字。2 つ先まで。既存の内容は上書き）・DBCS（4 字＋余り 2 字）
- AC2: pass — Field Exit 必須・自動 Enter・1 欄・挿入 0012 では流さない。ちょうど入る確定は何も流さない
- AC3: pass — mutation 8 通りのうち 5 通りが落ち、3 通りは等価変異

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。DBCS のテストの 1 回目は、10 バイトの欄の字数を数え違えて落ちた（SO/SI 込みで 4 字。テストの期待値を直した）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45313)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ACS の GUI 層の IME 確定・実ブラウザの IME（D2）

## 節目 11 の対応（独立点検 B の指摘を直した回）

### 実行したもの
- `cd packages/web-ui && npx vitest run test/ime-flow-next-field.test.ts` — 17 passed / 0 failed（型の違う欄の組 6 件・DBCS の上書き 1 件・DBCS の選択置換 1 件を足した）

### 受け入れ基準の再確認
- AC1〜AC3: 変更なし。追加で「満杯の欄が受けない字でも、次の欄の型で検査して流す」ことを型の違う 4 組（数値→英字・半角→全角・J→open・対照の英字→数値）で固定した。

### mutation
`scratchpad/mut-b12.py`（満杯判定を型検査の後へ戻す・DBCS を判定から外す・DBCS の選択置換でも判定する）— 3 通りのうち 2 通り検出。残り 1 つ（DBCS の選択置換でも判定する）は最初のテスト（末尾から離れた選択）では生存したが、**欄の最後の字の選択**（跡が欄の末尾に接する）のテストを足すと検出した（`scratchpad/mut-b12b.py`）。

### 未検証の穴
実ブラウザの IME の compositionend/input の順序は今回も未確認（jsdom まで）。
