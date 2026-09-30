# テスト結果: プリンターの keepAlive

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1242 passed / 0 failed
- `cd packages/server && npx vitest run` — 1692 passed / 0 failed / 3 skipped
- `npm run build` — OK
- 変異 5 通り（プリンターが常に入れる・渡さない・`printerOptsFrom` の転記漏れ・解決がプリンターを除く・全種別に載せる）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40927)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機の LAN の抜き差し・常駐プリンターが 15 分のアイドルで届かなくなる環境（この開発環境の実機は、当時の実測環境と同じ挙動かの再確認はしていない）
