# タスク: プリンター出力エラーの可視化と実行時 ON/OFF

## 1. server 状態
- [x] T1: `PrinterEntry` に `output`/`outputEnabled`/`outputWarnings`/`onOutputWarn` を追加
- [x] T2: `noteOutputWarn`（ログ＋履歴上限20＋push）を追加し、report ハンドラを `entry.output && entry.outputEnabled` 参照へ変更（依存: T1）
- [x] T3: `SessionManager.setPrinterOutputEnabled(id, enabled, user)`（assertOwner）を追加（依存: T1）

## 2. WS プロトコル
- [x] T4: `ws-messages.ts` に `printer-warn` / `printer-output-state` / `printer-output` を追加し `printer-opened` を拡張（hasOutput/outputEnabled/outputWarnings）

## 3. ws-handler
- [x] T5: `onOpenPrinter` で `onOutputWarn` を配線し拡張 `printer-opened` を送る（依存: T2,T4）
- [x] T6: `printer-output` を処理して `printer-output-state` を返す。`dispose` で `onOutputWarn` を解除（依存: T3,T4）

## 4. server テスト
- [x] T7: トグルで自動出力が停止/再開・警告が履歴に積まれる・他 owner は FORBIDDEN（依存: T3,T6）

## 5. web-ui
- [x] T8: `SessionState` に `outputConfigured`/`outputEnabled`/`printerWarnings` を追加
- [x] T9: `session-controller` で printer-opened 拡張・printer-warn・printer-output-state を処理し `setPrinterOutput` を追加（依存: T8）

## 6. PrinterPane
- [x] T10: `outputConfigured` のときだけ「自動出力: ON/OFF」トグルを表示し切り替える（依存: T9）
- [x] T11: 警告バー（最新メッセージ＋件数＋時刻、✕ で消去）を表示（依存: T9）

## 7. 検証・ドキュメント
- [x] T12: web-ui テスト（トグル表示条件・警告表示）
- [x] T13: README にエラー表示と実行時 ON/OFF を追記
- [x] T14: tsc・vue-tsc+vite・全テスト・lint が green
