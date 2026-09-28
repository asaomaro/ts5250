# 調査: HLLAPI のエラー 0x20

## 判明した事実
- F1（原典 `PS5250.processAIDCode`）: MF（0x14）→ 右寄せ・符号付き数値で MDT・`!isFieldExitReqFlag()`・`!fieldExited`・自動 Enter でない（0x20）→ 自己点検（0x15）→ ME（0x07）の順。
  `fieldExitReqFlag` は打鍵の `setMDT` で下がり（欄が Field Exit 必須なら）、Tab・Backtab・Home・上下の矢印・Field Exit などで着いた欄・打鍵で欄の終わりに着いたときに上がる。
- F2（実機・ACS のコア・2026-09-28。DSM の EXITREQ・`scripts/acs-probe/exit-required-aid.txt`・`exit-required-aid-arrow.txt`）: RZ に 12 → Enter は止まる（0020・inhibit 5）／
  同じ欄の中へ SetCursorPos → 止まる／別の欄へ置いて戻す（SetCursorPos）→ 止まる／Tab・Backtab で戻る → 送れた（3,10 から）／符号付き数値 → 止まる／
  右の矢印で欄の中 → 止まる／最終桁から右へ欄の外 → 3,16 から送れた（カーソル下に欄が無い）。
- F3（当 PJ）: `packages/server/src/hllapi.ts` の `aidCheck` は MF・自己点検・ME だけ（コメントに「エラー 32 は見ない」）。`Connection` はカーソルだけを持つ。

## 実装アンカー
- A1: `packages/server/src/hllapi.ts` `Connection`・`sendKey` の文字と移動の枝・`aidCheck`・`sendAid`
