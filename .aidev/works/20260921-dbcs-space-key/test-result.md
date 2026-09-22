# テスト結果: DBCS の欄の Space キー

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（DBCS の欄に触れる web-ui のテスト 22 ファイル）— 441 passed / 0 failed / 0 skipped（`dbcs-space-key.test.ts` の 4 件を足した）
- mutation（`scratchpad/mut-sp.py`）— 7 通り（空白でなくても変換・G を外す・J を外す・E を常に変換・E を外す・O も変換・打鍵の経路で変換しない）すべて落ちた
- 実機（社内機・ACS のコア）: `scripts/acs-probe/dbcs-space-key.txt` を通しで実行（dump 12 回）
- web-ui の型検査（`vue-tsc`）と全量は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — J・G は `あ　い`・先頭の Space も全角空白で、通知が出ない
- AC2: pass — E は `あ` の後だけ全角空白。`X Y`（SBCS）・空の欄の Space→`X` は SBCS のまま
- AC3: pass — O は `あ い`（SBCS の空白）
- AC4: pass — mutation 7 通りとも落ちる

## 失敗の証跡
このラウンドでは失敗が発生していない（変異は 1 回目で全部落ちた）。変更前の当 PJ の動きは、J・G の半角 Space が `dbcs-required`（「この項目には全角文字しか入力できません」）で拒否されること（`fieldValidate.ts` の `rejectReason`）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45559)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザの IME・直接入力（jsdom の keydown まで）
- 貼り付け・IME の確定の Space は変換しない（ACS の `processCharKeyStroke` は打鍵だけ）。ACS の貼り付けの空白の扱いは未測定
- E 欄で SBCS と DBCS を混ぜる規則は別の差（台帳）
