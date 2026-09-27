# テスト結果: EA の扱い（と画面の終わりを越える並び）

## 実行したもの
- `npx vitest run packages/tn5250` — 992 passed / 0 failed
- `npx vitest run packages/server` — 1 回目 1608 passed / 6 failed（6 件とも 5000ms の時間切れ。他セッションの負荷）→ 落ちた 4 ファイルを流し直して 39 passed / 0 failed
- `npx eslint packages/tn5250/src/protocol/wtd-applier.ts` — 指摘なし
- 変異: 書き始めの +1・タイプの判定・0x00 の消去——どれもテストで落ちる
- 実機（2026-09-27・社内機）: ACS のコア（`scripts/acs-probe/ea-acs.txt`・ワイヤは `tap-proxy.mjs`）6 通り、当 PJ（`scripts/verify-ea-acs.mjs`）直す前 4 通りとも X が 1 桁ずれ・否定応答なし → 直した後 6 通りとも pass=20。片付け済み

## 再テスト（review ラウンド 1 の後）
- `npx vitest run packages/tn5250` — 995 passed / 0 failed
- 実機: EATESTWRAP を足した 7 通りで `verify-ea-acs.mjs` pass=25 fail=0。片付け済み

## 受け入れ基準ごとの判定
- AC1: pass — 6 通り（0xFF・0x00・0x01・長さ 3・EA 24,80 の後ろ・24,79 から XYZ）で ACS と同じ
- AC2: pass — `wtd-order-sense.test.ts`・`wtd-applier.test.ts`
- AC3: pass — DLTPGM（CPC2191・CHKOBJ で CPF9801）・IFS の削除・ワイヤの記録の shred

## 失敗の証跡
```
$ npx vitest run packages/server   （1 回目）
 FAIL  packages/server/test/app-auth.test.ts > 認証・per-user 分離 > 認証 ON: 未認証で保護ルートは 401、login 後は Cookie で通る
      6 Error: Test timed out in 5000ms.
 Test Files  4 failed | 106 passed | 1 skipped (111)
      Tests  6 failed | 1608 passed | 3 skipped (1617)
$ npx vitest run <落ちた 4 ファイル>
 Test Files  4 passed (4)
      Tests  39 passed (39)
```

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 44747)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- DBCS のセッションの 0x05（原典と単体テストだけ）・TD が画面の終わりを越える形
- web-ui の全テストは回していない（core の変更。web-ui は snapshot を受けるだけ）
