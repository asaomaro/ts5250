# 仕様: ホストのエラーの保留の残り

## 設計方針
- コアに `setSysReqLine(open)` を足し、`holdWtd` をエラーのメッセージか SysReq の行で立てる。閉じたら止めた出力を流す（`dismissHostError` と同じ `releaseHeld`）。行から SysReq を送るときは送ってから閉じる（ACS の順）。
- ws の `sysreq-line { open }` を足し、web-ui は行を出す・取り消す・フォーカスを失うときに知らせる（確定は送らない＝コアが送ってから閉じる。切断時は送らない）。
- 保留が始まったレコードの警報・メッセージ待ちは `heldCc2` に持ち越し、流し終えてから当てる（メッセージ待ちはレコード全体の OR で「点ける」が勝つ）。
- CANCEL INVITE で `readOutstanding = false`、RESTORE で `true`。

## 依拠する既存の事実
- research F1〜F5。保留の仕組み（`20260927-host-error-hold`）

## 受け入れ基準との対応
- AC1: `packages/tn5250/test/host-error-hold.test.ts`・`packages/web-ui/test/sysreq-line.test.ts`・`scripts/verify-sysreq-line-hold.mjs`
- AC2: 同じテスト・`verify-sysreq-line-hold.mjs HOLDCC2`
- AC3: `packages/tn5250/test/wec-only-unlock.test.ts`
- AC4: DLTPGM と IFS の削除
