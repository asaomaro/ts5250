# テスト結果: 欄の外の End

## 実行したもの
- web-ui のキー・カーソルに触れる 45 ファイル — 561 passed / 0 failed。型検査（`vue-tsc --noEmit`・test 込み）通過。
- 節目（マイルストーン 7）の独立点検への対応後: 全量 6,349 passed / 0 failed / 41 skipped（1 回目は既存のプリンターのテスト 1 件が並列の負荷で時間切れ。証跡は `20260921-device-name-acs` の test-result.md）・lint・build（vue-tsc 含む）通過。mutation 24 通り（`scratchpad/mut-m7.py`）と当て直し 2 通りをすべて検出。
- 施錠中の欄の外の End が再帰しないこと（`pane-nav.test.ts`）・継続欄の着地・保護欄の上の End（`end-key-acs.test.ts`）は単体。

## 受け入れ基準ごとの判定
- AC1: pass — カーソルより後の最初の欄・巡回・継続欄の先頭の区切りだけ。
- AC2: pass — 入力の直後（2）、埋まっていれば最後の桁（4）。
- AC3: pass — mutation 4 通り（旧い動き・巡回しない・末尾へ置かない・継続欄の区切りも数える）。最後の 1 つは最初は素通りし、継続欄のテストを足して検出した。

## 失敗の証跡

```
$ npx vitest run test/pane-nav.test.ts   # 実装を変えた直後
 × Home/End で最初/最後の入力欄へ（欄外＝ペインにフォーカス時）
```
旧い動き（最後の入力欄へ）を固定していたテスト。ACS に合わせて書き換えた。

```
SURVIVED 継続欄の区切りも数える :: 35 passed (35)
```

このラウンドでは失敗が発生していない。

## 起動確認（smoke）

```
$ aidev smoke
smoke: 20260921-end-outside-field
smoke: /healthz ok, / が Web UI を返した (port 45485)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- ACS のコアで欄の外の End を測っていない（D2）。実ブラウザ。
- 保護（バイパス）欄の上の End を ACS のコアで測っていない（DSPATR(PR) の入力欄を持つ画面を用意できていない。原典と単体まで）。
