# 調査: ACS の起動応答の読み方

## 判明した事実
- F1（原典）: `DS5250.processStartUpConfirmation` は成功のとき `new CodePage(37, 2)` でシステム名（8）・装置名（10）・ジョブ名を取り出し、装置名を
  `SetWorkstationID` に入れる。セッションのコードページは使わない。
- F2（当 PJ の codec）: 0x5B は 37・939・1399 で `$`、930・5026 で `¥`（`codecForCcsid(...).decode` で確かめた）。`#`・`@`・`_`・英数字は同じ。
- F3（当 PJ）: `parseStartupResponse(record, codec)` は表示（`session.ts`）とプリンター（`printer-session.ts`）がそれぞれのセッションの codec を渡していた。
