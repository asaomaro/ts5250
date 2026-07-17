# タスク: TN5250E プリンターセッション（SBCS end-to-end）

## core
- [x] T1: `TelnetLayer`/`TelnetOptions` に `ibmFont`/`ibmTransform` を追加し、NEW-ENVIRON 応答に USERVAR
      `IBMFONT`/`IBMTRANSFORM` を送る。単体: SB 応答バイトに両 USERVAR が載る（無いと 8925 の再現防止）。
- [x] T2: `terminalTypeFor` にプリンター分岐（SBCS=`IBM-3812-1`）。プリンター用の解決経路を用意（引数 or 別関数）。
- [x] T3: `protocol/scs.ts` に `LogicalPage`/`SpoolReport` 型と `ScsDecoder` を実装（SBCS）。単バイト
      NL/CR/FF/RNL/LF/PP と `0x2B` オーダーのページ幾何反映、未対応は長さ分スキップ、EBCDIC→Unicode。
      単体: `artifacts/scs-capture-sbcs.bin` を golden fixture に論理ページ（行・改ページ）を固定化。（依存: なし）
- [x] T4: `session/printer-session.ts` に `PrinterSession extends Emitter` を実装。交渉→起動応答判定
      （(6+data[6])+5 の4B EBCDIC、I90x 成功/8xxx 例外）→印刷データ受信ごとに print-complete 応答→
      Job Complete(0x11) で `report` emit。単体: `ReplayTransport` で録画再生。（依存: T1,T2,T3）
- [x] T5: `core/index.ts` に `PrinterSession`/`ScsDecoder`/型を export。（依存: T4）

## server + MCP
- [x] T6: `session-manager.ts` に `kind:"display"|"printer"`。printer は `PrinterSession` を open/track。（依存: T5）
- [x] T7: `ws-messages.ts` に `open.kind` と server→client `report`/`printer-status`。`ws-handler.ts` で
      PrinterSession の `report` を購読し push。（依存: T6）
- [x] T8: `mcp-tools.ts` に `open_printer_session`/`wait_spool`/`list_spools`/`get_spool`（close は流用）。
      戻り値は等幅テキスト。（依存: T6）
- [ ] T9: `profiles.ts` にセッション種別（任意項目）。（依存: T6）

## web-ui
- [ ] T10: `stores/sessions.ts` を kind 判別 union 化（既存 display はそのまま、printer 状態
      reports[]/selectedReportId を追加）。（依存: T5）
- [ ] T11: `ConnectView.vue` にセッション種別（display/printer）選択を追加し `open.kind` を送る。（依存: T10）
- [ ] T12: `PrinterPane.vue`（左=受信スプール一覧／右=等幅帳票ビュー／保存ツールバー: テキスト＋印刷→PDF）。
      タブ内容の kind 振り分けで printer→PrinterPane。単体: 論理ページ→行描画のロジック。（依存: T10,T13）
- [ ] T13: `ws-client.ts`/`session-controller.ts` で `report`/`printer-status` を処理し store へ反映。（依存: T7）

## 統合・文書
- [x] T14: `scripts/verify-printer.mjs`（実機 SBCS: I902→スプール受信→論理ページ、CPA3394 応答込み）。
      `artifacts/probe-printer-*.mjs` を種に。（依存: T5）
- [ ] T15: `README.md`/`docs/PROTOCOL.md`/`scripts/README.md` にプリンターセッション節（対応範囲・MCP ツール・
      CPA3394 運用・既知の制約: DBCS 未対応/自動PDF未実装）。（依存: T12,T14）
