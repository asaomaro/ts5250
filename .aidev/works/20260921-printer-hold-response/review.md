# レビュー: 出力に失敗したら応答を止める

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・4 件をまとめて。差し戻し）
- 別コンテキストに 4 コミット（c4e95099・5ef66a88・3c3b20ad・7100197a）を読ませた。R1〜R7 は点検役が自作の再現テスト（scratchpad）で裏を取った指摘。
- [must][conv:-] `session-manager.ts` `runOutputs`・`printer-output.ts` `printRaw` — ホスト変換＋PDF 保存先で、PDF を作らない（仕様どおり）のを失敗と数えて帳票ごとに応答を止め、再試行でも抜けられない（R1）/ 対応: `pdfSkipped`・`pdf.skipped` を立て、`outputFailed` が数えない。テスト 1 件
- [must][conv:-] `session-manager.ts` `runOutputs`・`closed` — 出力中に停止・切断すると、閉じた接続の `release` を持つ `heldOutput` が後から作られる（R3）。張り直しの後に古い側が新しい側の `heldOutput` を上書きしうる / 対応: 接続ごとの `PrinterConn` を持たせ、閉じた接続の失敗は止めずに `dropped` にする。テスト 1 件
- [should][conv:-] `session-manager.ts` `closed` — 止めていた帳票を捨てても画面へ知らせず、再試行バーが残る（R2）。帳票 id が接続ごとに 1 から振り直される / 対応: `dropped` の状態を配る、帳票の連番を接続またぎで数える（`nextReportSeq`・`spoolSeq`）。テスト 3 件
- [should][conv:-] `session-manager.ts` `setPrinterOutputEnabled` — 自動出力を OFF にしても止めた帳票を放さず、OFF の間の再試行が出力する（R4）/ 対応: OFF で応答して `skipped`。テスト 1 件
- [should][conv:-] `session-manager.ts` `retryPrinterOutput` — 再試行が止めた時点の設定の写しを使い、保存先を直しても効かない（R6）/ 対応: 失敗した種類だけを持ち、いまの `entry.output` から組み直す。外された出力はやり直さない。テスト 2 件
- [should][conv:-] `printer-output.ts` `lpPrint`・`print-windows.ts` — lp が返らないと応答が止まったまま `held` にもならない（R7）/ 対応: 子プロセスに 120 秒の時間切れ、止めたら失敗。テスト 4 件（`spawn` を差し替え）
- [should][conv:-] `session-manager.ts` 549・1262 — 再試行・取消が状態を置き換え、成功した PDF の ✓ と保存先が消える（R5）/ 対応: やり直さなかった側を引き継ぐ・取消は結果を残す。画面もチップを並べる。テスト 3 件
- [should][conv:-] `mcp-tools.ts`・`host-printers.ts` — 止めていることが MCP にもサービス画面にも出ず、MCP から開いたプリンターは抜ける手段が無い / 対応: `wait_spool` / `list_spools` の `held`、`retry_printer_output` / `cancel_printer_output`、`/api/printers` の `held` と画面のチップ。テスト 5 件
- [should][conv:-] `ws-handler.ts` 900 — フックがエントリに 1 つで、2 タブで開くと後が上書きし、閉じると先にも届かない / 対応: `PrinterListener` の集合にしてタブごとに付け外し。テスト 2 件
- [should][conv:-] `session-manager.ts` 1048・requirements 20 行 — 「繋ぎ直せば送り直してくる」を実測なしで事実として書いた / 対応: PUB400 で 2 回測った（`scripts/verify-printer-hold-drop.mjs`）。切断で RDY に戻り、繋ぎ直すと用紙の問い合わせに答えた後で送り直された。記述を実測に合わせた
- [should][conv:-] `.aidev/backlog/acs-parity.md` 306-311 — `[x]` の本文に残りを埋め、起票時の症状を取り消し線なしで残した / 対応: 残りを兄弟の `- [ ]` に割り、症状に取り消し線
- [should][conv:-] `printer-session.ts`（主エージェントが原典で確認した懸念）— CLEAR で閉じた帳票も止めていた。ACS がエラーで止まるのはデータを書くときだけで、閉じるときの失敗は記録するだけ（`PSNVT5250P.closePrinterIfRequired`）/ 対応: CLEAR で閉じた帳票は待たない（`cleared`）。テスト 2 件
- [nit][conv:-] `session-manager.ts` 546-550 — `failedOnly` が `buildOutputStatus` の JSDoc との間に挟まった / 対応: 並べ直した
- [nit][conv:-] `PrinterPane.vue` 106・109 — チップの文言が直書き / 対応: `opMessages.ts` の定数にし、テストも定数を参照
- [nit][conv:verify-by-mutation!] `printer-hold-response.test.ts` ws の節 — 偽の sessions が `user` を捨て、認可の素通りを検出しない / 対応: 利用者を渡したことまで見る

## ラウンド 3（通過）
- 修正を外す mutation（`scratchpad/mut-r6.py`）で検出。点検役の再現テスト R1〜R6 は修正後に落ちる（欠陥が消えた）。R7 は時間切れが 120 秒なので 1.5 秒の観測では変わらない（時間切れはモックで固定）。
