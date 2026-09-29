# テスト結果: 台帳を閉じる

## 実行したもの
- `node --env-file=.env --env-file=.env.verify scripts/acs-probe.mjs scripts/acs-probe/wdsf-minor.txt AS400`（ACS のコア）— M01〜M15 は CPFA304、M16〜M18 は rc=0
- `node --env-file=.env --env-file=.env.verify scripts/verify-wdsf-minor.mjs`（当 PJ のコア）— `RESULT: pass=18 fail=0`（2 回）
- `npx eslint scripts/verify-wdsf-minor.mjs` — 指摘なし
- `grep -c "^- \[ \]" .aidev/backlog/acs-parity.md` — 0

## 受け入れ基準ごとの判定
- AC1: pass
- AC2: pass

## 失敗の証跡
このラウンドでは失敗は発生していない。

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 39217)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 必須でないと判断して閉じた項目は、実装も測定もしていない（台帳の各項目に理由）
