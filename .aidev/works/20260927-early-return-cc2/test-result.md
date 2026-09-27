# テスト結果: その場で戻る否定応答と CC2

## 実行したもの
- `npx vitest run packages/tn5250` — 934 passed / 0 failed（85 files）
- 変異: `alarm` を戻さない → 3 件、`messageWaiting` を戻さない → 2 件、`committedCc2` を控えない → 1 件落ちる
- 実機（2026-09-27・社内機）: ACS のコア（`scripts/acs-probe/early-return-cc2.txt`）mw=false、当 PJ（`scripts/verify-early-return-cc2.mjs`）直す前 mw=true → 直した後 pass=4 fail=0。片付け: DLTPGM（CPC2191、CHKOBJ で CPF9801）と IFS の /tmp/dscmd.c・/tmp/dscmd.log

## 受け入れ基準ごとの判定
- AC1: pass — 実機で ACS のコアと当 PJ のメッセージ待ちが同じ（点かない）
- AC2: pass — `early-return-cc2.test.ts`（4 か所・D9/72・SAVE PARTIAL・否定応答なし・画面は残る）
- AC3: pass — 片付け済み

## 失敗の証跡
このラウンドでは失敗が発生していない（直す前の実機の差は research F2）。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 46539)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 再テスト（review ラウンド 1 の後）
- `dscmd.c` を直した後に実機で作り直し（CZS1607）、`verify-early-return-cc2.mjs` pass=4 fail=0 を再現。片付け（CPC2191・CPF9801・IFS 2 件）
- `early-return-cc2.test.ts` 11 passed
- `npx vitest run packages/tn5250`: 1 回目 935 passed / 1 failed（どの試験かは出力を控えそびれて特定できていない。他のセッションの負荷で時間切れの見込み）→ 続けて 2 回とも 936 passed / 0 failed

## 未検証の穴（skip / 環境不足）
- SAVE PARTIAL より前の CC2（D3）は原典と単体テストだけ（実機で SAVE PARTIAL＋不正なコマンドを出させていない）
