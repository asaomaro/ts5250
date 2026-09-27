# テスト結果: 長さの足りないコマンドの否定応答

## 実行したもの
- `npx vitest run packages/tn5250` —       Tests  945 passed (945)
- 変異: 5 つの検査のそれぞれを緩める（need−1 以下）・きつくする（need＋1）——どれもテストで落ちる
- 実機（2026-09-27・社内機）: ACS のコア（`scripts/acs-probe/short-command-sense.txt` を 1 モードずつ）5 通りとも SHORT・mw=false・否定応答。当 PJ（`scripts/verify-short-command-sense.mjs`）直す前は 4 通りとも否定応答なし（3 通りは例外）→ 直した後 5 通りとも pass（12＋3）。
  片付け: DLTPGM（CPC2191・CHKOBJ で CPF9801）と IFS の /tmp/dscmd.c・/tmp/dscmd.log

## 受け入れ基準ごとの判定
- AC1: pass — 5 通りで ACS のコアと当 PJ の画面・メッセージ待ち・否定応答が同じ
- AC2: pass — `early-return-cc2.test.ts`（8 形とちょうど足りる対照）・`window-error-code.test.ts`
- AC3: pass — 片付け済み

## 失敗の証跡
このラウンドでは失敗が発生していない（直す前の実機の差は research F2）。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 45771)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- READ の 0x42・0x82 の短い形は実機で出させていない（原典の同じ検査）
- CLEAR UNIT ALTERNATE の引数なし（decisions D2・backlog）
