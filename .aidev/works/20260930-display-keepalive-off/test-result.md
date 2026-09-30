# テスト結果: 表示セッションの keepAlive

## 実行したもの
- `cd packages/tn5250 && npx vitest run` — 1240 passed / 0 failed
- `cd packages/server && npx vitest run` — 1689 passed / 0 failed / 3 skipped
- `npm run build` — OK
- 変異 7 通り（トランスポートの既定・false の無視・セッションが常に入れる・渡さない・解決で落とす・解決が種別を問わない）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 41049)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実機の LAN ケーブルの抜き差しは再現していない**（この開発環境では回線を切れない）。Windows の Node の keepalive（1 秒間隔 × 10 回）は OS の仕様からの説明で、利用者の環境での確認が要る
- Windows 以外（Linux は 75 秒 × 9 回で、10 秒程度の断では落ちにくい）
