# テスト結果: 関連付けで起こしたプリンターを監査に残す

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run test/ws-associated-printer.test.ts test/audit.test.ts`（server）— 29 passed / 0 failed / 0 skipped（監査のテスト 5 件を足した。時間切れは既存の 5 秒のテストに監査の確認を足した）
- `npx eslint`（変更した 2 ファイル）— exit 0 / `tsc -p packages/server --noEmit` — exit 0
- mutation（`scratchpad/mut-audit.py`）— 5 通り（監査を出さない・失敗も ok・理由を `code` に載せない・指定が無くても記録・設定の参照を載せる）すべて落ちた

## 受け入れ基準ごとの判定
- AC1: pass — 成功で `ws_associated_printer` が 1 件（`ok`）。使い回しでも 1 件
- AC2: pass — `invalid`・`failed`・`timeout` を `error` と `code` で記録
- AC3: pass — 関連付けを指さない表示では 0 件
- AC4: pass — 載せるキーは `op`・`result`・`durationMs` だけ（`Object.keys` で固定）。mutation で外すと落ちる

## 失敗の証跡
このラウンドでは失敗が発生していない（mutation の 5 通りはすべて 1 回目で落ちた）。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45455)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機のホストへは当てていない（監査はサーバーの記録だけで、ホストの挙動に触れない）
