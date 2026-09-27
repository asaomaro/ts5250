# テスト結果: その場で戻る否定応答の残り

## 実行したもの
- `npx vitest run packages/tn5250` — 1014 passed / 0 failed
- 変異: 持ち越し（送らない・ガードを外す・上書きしない・データの無いレコードでも送る）——どれも落ちる
- 実機（2026-09-27・社内機）: ACS のコア（`scripts/acs-probe/early-return-rest.txt`・ワイヤ）と当 PJ（`scripts/verify-early-return-rest.mjs` pass=4）。片付け済み

## 受け入れ基準ごとの判定
- AC1: pass — research F5・F6
- AC2: pass — `early-return-rest.test.ts` 8 件
- AC3: pass — DLTPGM（CPC2191・CPF9801）・IFS・ワイヤの記録の shred

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 46601)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- READ の CC1（原典だけ）・警報の回数（音は測れない。D1）
- review の後の持ち越しの直し（1 つの置き場・データの無いレコード）は単体テストだけ（実機の SPROLL の形は変わらない）
