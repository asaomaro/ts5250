# テスト結果: ホストサーバーの keepAlive

## 実行したもの
- `cd packages/hostserver && npx vitest run` — 1022 passed / 0 failed
- `cd packages/server && npx vitest run` — 1694 passed / 0 failed / 3 skipped
- `npm run build` — OK
- 実機（DB・IFS の接続。新しい既定）— `db ok rows=1`・`ifs ok`
- 変異 8 通り（トランスポートの常時有効・指定の無視・DDM・接続クラスの受け渡しの欠落・`hostAuthFrom` の転記漏れ・解決が種別を絞る）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39899)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 常駐監視が無通信で落とされる環境の再現・LAN の抜き差しは、この開発環境では確認していない
