# タスク: PDF 作成・自動印刷の結果ステータス表示

- [x] T1: `printer-output.ts` の `HandleReportResult` に `pdfError`/`printer`/`printError` を追加し設定する
- [x] T2: `session-manager.ts` に `PrinterEntry.outputStatuses`（上限100）と status 生成（成功/失敗/skipped）を追加（依存: T1）
- [x] T3: status の push フック（`onOutputStatus`）を追加（依存: T2）
- [x] T4: WS 型に `printer-output-result` を追加し `printer-opened` に `outputStatuses` を載せる
- [x] T5: `ws-handler.ts` で status push を配線し `printer-opened` を拡張（依存: T3,T4）
- [x] T6: server テスト（PDF 成功/失敗・印刷成功・skipped・設定なし）（依存: T5）
- [x] T7: web-ui `SessionState.outputStatuses` と `session-controller` の受信処理（依存: T4）
- [x] T8: `PrinterPane` 一覧行に簡易ステータス（✓/✗/–/⏸）（依存: T7）
- [x] T9: `PrinterPane` 選択スプールの詳細（保存先/プリンター名/失敗理由）（依存: T7）
- [x] T10: web-ui テスト（一覧の簡易表示・詳細・設定なしで非表示）
- [x] T11: README 追記
- [x] T12: tsc・vue-tsc+vite・全テスト・lint が green
