# テスト結果: 心拍で切れたときの猶予

## 実行したもの
- `cd packages/server && npx vitest run` — 1684 passed / 1 failed（`printer-hold-response`。負荷での揺れで、個別に 2 回流すと 19 passed）/ 3 skipped
- `npm run build`（tsc -b・vue-tsc）— OK
- 実機（サーバー経由の /ws・既定の設定）: 心拍に返事しない接続は 260 秒後に `open { sessionId, resume: true }` で同じセッション（メインメニュー）へ戻れた。閉じた接続は 110 秒後に `SESSION_NOT_FOUND`
- 変異 6 通り（`stalled` を渡さない・渡した値の握りつぶし・マネージャが無視・`max` 無し・猶予なしの逃げ道・閉じたときまで延長）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
全体の実行で `printer-hold-response` の 1 件が落ちたが、今回の変更と無関係（プリンターの出力の再試行）で、個別実行は 2 回とも通った:

```
FAIL  test/printer-hold-response.test.ts > 出力に失敗したら応答を止める > **再試行で出力できたら応答する**（保存先を作ってから再試行）
（個別実行: Tests 19 passed (19) を 2 回）
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40649)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ブラウザの実物でタブを眠らせての確認はしていない（心拍に返事しない WebSocket で再現）
