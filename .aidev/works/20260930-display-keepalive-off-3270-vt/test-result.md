# テスト結果: 3270・VT の keepAlive

## 実行したもの
- `cd packages/tn3270 && npx vitest run` — 258 passed / 0 failed / 38 skipped
- `cd packages/vt && npx vitest run` — 206 passed / 0 failed
- `cd packages/server && npx vitest run` — 1691 passed / 0 failed / 3 skipped
- `npm run build` — OK
- 変異 6 通り（3270・VT のセッションが常に入れる・トランスポートの false の無視・ws-handler の 3270・VT の 2 か所・解決が 5250 だけ）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40309)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機の LAN の抜き差しは再現していない（#460 と同じ）
- `Tn3270Manager`・`VtManager` の受け渡し（2 行）は単体で直接見ていない
