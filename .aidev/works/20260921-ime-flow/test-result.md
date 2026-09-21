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
