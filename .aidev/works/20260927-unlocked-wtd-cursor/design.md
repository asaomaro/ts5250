# 仕様: 溜めた AID のカーソル

## 設計方針
- 溜めるとき（`sendAid`）にカーソル（`opts.cursor` を反映した後の `buf.cursorAddr`）を持ち、送るときにその位置で組む。欄の値は送るときの画面。
- CC1 の施錠では捨てない（F3）。WEC・Attn / SysReq・繋ぎ直しでは捨てる（従来どおり）。
- 解錠中の WTD のカーソルは変えない（F2）。

## 依拠する既存の事実
- research F2・F3

## 受け入れ基準との対応
- AC1: `test/wec-only-unlock.test.ts`（押したときのカーソル・CC1 で捨てない）。解錠中の WTD は既存の実装のまま（実機で一致）
- AC2: `verify-unlocked-wtd-cursor.mjs` pass=3・`verify-wec-only-unlock.mjs` WECONLY / WECONLYW / WECTWICE pass=3 ずつ
- AC3: DLTPGM と IFS の削除
