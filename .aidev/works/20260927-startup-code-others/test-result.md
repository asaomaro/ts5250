# テスト結果: 起動応答 I901・I902 以外のコードの扱い

## 実行したもの
- `npx vitest run packages/tn5250/test/session.test.ts packages/tn5250/test/startup-reject.test.ts` — 51 passed / 0 failed
- `javac -cp <acshod2.jar> scripts/acs-probe/AcsProbe.java` — exit 0（dump を足した後）
- 変異: `STARTUP_SUCCESS_CODES` から I906 を外すと I906 のテストが落ちる
- 実機（2026-09-27・社内機。QRMTSIGN *FRCSIGNON）: ACS のコア（`PROBE_BYPASS_SIGNON=clear`・`startup-i906.txt`）と当 PJ（`Session5250.connect` の user/password）がどちらも I902＋サインオン画面（research F5）

## 受け入れ基準ごとの判定
- AC1: pass — I906 の起動応答の後ろのサインオン画面（PUB400 の実物のリプレイ）が出て、`startup` に装置名が採られる
- AC2: pass — 表に無いコード Z123（装置名つき）でも同じ
- AC3: pass — I906 は出させられなかった（*FRCSIGNON でも I902）。research F5 に記録、backlog に未確認を残す（deliver）
- AC4: pass — decisions D1（原典 `processStartUpConfirmation`・`processDiagnosticInformation`・`SetWorkstationID`）

## 失敗の証跡
このラウンドでは失敗が発生していない。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 46149)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- I906 の実機での ACS・当 PJ の見え方（出させる条件が分からない。共有の実機のシステム値は変えない）
- 変更後の `AcsProbe.java` の dump は実機で流し直していない（測定はコメントを直す前。出力の形は同じ）
