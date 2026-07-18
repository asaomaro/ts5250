# 計画: PDF 作成・自動印刷の結果ステータス表示

## 実装方針
printer-output（結果の充実）→ session-manager（状態化）→ WS → web-ui（表示）の順。既存の警告バー・
サーバーログは維持し、成功も見えるようにする。subtask 分割なし（1 PR）。

## 作業順序と依存関係
1. `printer-output.ts`: HandleReportResult に pdfError/printer/printError を追加（warn は継続）
2. `session-manager.ts`: PrinterEntry.outputStatuses、結果から status 生成（skipped 含む）、push フック
3. WS 型: printer-output-result 追加・printer-opened に outputStatuses
4. `ws-handler.ts`: status push 配線・printer-opened 拡張
5. server テスト（成功/失敗/スキップの status 生成）
6. web-ui: SessionState.outputStatuses・session-controller 受信
7. PrinterPane: 一覧行の簡易表示＋選択時の詳細
8. web-ui テスト・README・全体検証

## リスク / 留意点
- 出力設定が無い側は**キーを省略**して「設定なし」を表現（`ok:false` と混同しない）。
- 保持上限 100 件でメモリ肥大を防ぐ。
- 既存の警告バーと二重にならないよう、status は「結果の記録」、警告バーは「失敗の即時通知」と役割を分ける。

## テスト方針
- server: PDF 成功で path、失敗で error、印刷成功で printer、無効時 skipped、設定なしでキー省略。
- web-ui: 一覧に簡易ステータス、選択で詳細、設定なしセッションでは非表示。
