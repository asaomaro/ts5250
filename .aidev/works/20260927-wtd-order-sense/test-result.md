# テスト結果: WTD の中のオーダーの誤り

## 実行したもの
- `npx vitest run packages/tn5250` — 981 passed / 0 failed
- `npx eslint packages/tn5250/src/protocol/wtd-applier.ts` — 指摘なし
- 変異: SOH の長さ・EA の長さ・RA / EA の後戻り（1 桁の境界）・EA の長さ不足・主ループの打ち切り——どれもテストで落ちる
- 実機（2026-09-27・社内機）: ACS のコア（`scripts/acs-probe/wtd-order-sense.txt` を 1 モードずつ・`tap-proxy.mjs` でワイヤも記録）5 通りとも誤りの前を書き・mw=true・原典どおりのセンス。
  当 PJ（`scripts/verify-wtd-order-sense.mjs`）直す前は否定応答なし（3 通りは例外で CC2 も落ちた）→ 直した後 pass=15（dscmd.c を直した後に作り直してもう一度 pass=15）。片付け済み

## 受け入れ基準ごとの判定
- AC1: pass — 5 通りで画面・メッセージ待ち・センスが ACS と同じ
- AC2: pass — `wtd-order-sense.test.ts` 36 件
- AC3: pass — DLTPGM（CPC2191・CHKOBJ で CPF9801）・IFS の削除・ワイヤの記録は読み終えて shred

## 失敗の証跡
このラウンドでは失敗が発生していない（直す前の実機の差は research F2）。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 44725)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 長さが画面を超える TD（D3）・IC / MC / TD / SF / WEA の短い形は実機で出させていない（原典と単体テスト）
- SBA の 1,0・SF の中身の誤りなどは backlog
