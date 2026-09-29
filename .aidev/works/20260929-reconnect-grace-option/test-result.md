# テスト結果: `--reconnect-grace`

## 実行したもの
- `cd packages/server && npx vitest run` — 1677 passed / 0 failed / 3 skipped
- `npm run build`（tsc -b・vue-tsc）— OK
- 実機（サーバー経由の /ws・`ping` に返事しない）: 既定のサーバーは 260 秒後の `open { sessionId, resume: true }` が `SESSION_NOT_FOUND`、`--reconnect-grace 10` のサーバーは同じセッションの画面（メインメニュー）が返った
- 変異 3 通り（受け渡しの欠落・単位・範囲）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass — `packages/server/test/reconnect-grace-option.test.ts`（5 件）
- AC2: pass — 上の実機の比較

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40459)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- ブラウザの実物（タブを実際に眠らせる）での確認はしていない。心拍に返事しない WebSocket で再現した
