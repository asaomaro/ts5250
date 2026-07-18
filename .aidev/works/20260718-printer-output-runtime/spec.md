# 仕様: プリンター出力エラーの可視化と実行時 ON/OFF

## 概要
プリンター出力（PDF 自動蓄積・自動印刷）の**失敗を WS で push して画面に表示**し、**セッション単位の
有効/無効トグル**を追加する。出力設定の値自体は変更しない（信頼境界維持・ON/OFF のみ）。

## 設計方針
- 出力設定と実行時状態を **`PrinterEntry` に持たせる**（現在は `opts.output` の closure 参照で切り替え不能）。
- 警告は**非同期に発生**するため、WS の新メッセージで push（Q1）。同時にセッションへ履歴を残し、
  後から画面を開いても直近の警告が見える（Q3）。
- ON/OFF はセッション単位の状態なので **WS のクライアント→サーバーメッセージ**で切り替える（Q2）。
- サーバーログ（`printerLog.warn`）は従来どおり出す。

## インターフェース / データ構造

### server: PrinterEntry（session-manager）
```ts
interface PrinterEntry {
  // …既存…
  /** 出力設定（プロファイル由来）。未設定なら出力機能なし */
  output?: PrinterOutputConfig;
  /** 実行時の有効/無効（既定 true）。false の間は自動出力しない */
  outputEnabled: boolean;
  /** 直近の出力警告（上限 20 件・古いものから捨てる） */
  outputWarnings: { at: number; message: string }[];
  /** 警告 push フック（ws-handler が設定・切断で解除） */
  onOutputWarn?: (w: { at: number; message: string }) => void;
}
```
- report ハンドラ: `if (entry.output && entry.outputEnabled) handleReport(report, entry.output, warn)`。
  warn は `noteOutputWarn(entry, msg)` = **ログ出力＋履歴追加＋onOutputWarn 通知**。
- `SessionManager.setPrinterOutputEnabled(id, enabled, user)`: `assertOwner` 後に `outputEnabled` を更新して返す。

### WS メッセージ（ws-messages.ts）
```ts
// server → client
interface WsPrinterOpened { type: "printer-opened"; sessionId; startupCode;
  /** 出力設定があるか（トグル表示条件） */ hasOutput: boolean;
  /** 現在の有効/無効 */ outputEnabled: boolean;
  /** 既存の警告履歴（再接続・後から開いた画面向け） */ outputWarnings: { at: number; message: string }[]; }
interface WsPrinterWarn { type: "printer-warn"; sessionId: string; at: number; message: string }
interface WsPrinterOutputState { type: "printer-output-state"; sessionId: string; enabled: boolean }
// client → server
interface WsPrinterOutput { type: "printer-output"; enabled: boolean }
```

### ws-handler
- `onOpenPrinter`: `entry.onOutputWarn = (w) => this.send({ type: "printer-warn", sessionId: entry.id, ...w })` を設定し、
  `printer-opened` に `hasOutput`/`outputEnabled`/`outputWarnings` を載せる。
- `printer-output` を受けたら `sessions.setPrinterOutputEnabled(sessionId, enabled, user)` → `printer-output-state` を返す。
- `dispose`（切断）時に `entry.onOutputWarn` を解除する（リーク防止）。

### web-ui
- `SessionState` に追加: `outputConfigured?: boolean`、`outputEnabled?: boolean`、
  `printerWarnings?: { at: number; message: string }[]`。
- `session-controller`:
  - `printer-opened` で上記を初期化。
  - `printer-warn` を受けたら `printerWarnings` に追加（上限 20）。
  - `printer-output-state` で `outputEnabled` を更新。
  - `setPrinterOutput(sessionId, enabled)` を追加（WS 送信）。
- `PrinterPane`:
  - **トグル**: `outputConfigured` のときだけツールバーに表示。ラベルは `自動出力: ON / OFF`。押下で
    `setPrinterOutput` を送る（楽観更新はせずサーバー応答で反映）。
  - **警告表示**: `printerWarnings` があれば本文上部に警告バーを出す（最新メッセージ＋件数、時刻付き）。
    ✕ で消去（クライアント側のクリア。サーバー履歴は保持）。

## 振る舞いの詳細
- 既定は `outputEnabled = true`（出力設定があれば従来どおり自動出力）。
- 無効中に受信したスプールは**受信・表示・手動 PDF/印刷は従来どおり**動く（自動出力だけ止まる）。
- 出力失敗は受信処理を妨げない（既存どおり catch して警告に落とす）。
- 出力設定が無いセッションではトグルを出さず、`hasOutput=false`。

## エラー処理 / 異常系
- `setPrinterOutputEnabled` は他 owner なら FORBIDDEN（既存 `assertOwner`）。セッション不明は SESSION_NOT_FOUND。
- 警告履歴は上限 20 件でリングのように古いものを捨てる（メモリ肥大の防止）。

## 受け入れ基準との対応
- 失敗が画面に出る → `printer-warn` push ＋ `PrinterPane` の警告バー（履歴は `printer-opened` でも配送）。
- 設定があるときだけトグル → `hasOutput` による表示制御。
- トグルで停止/再開 → `entry.outputEnabled` を report ハンドラで参照。
- 既定有効・ログ維持 → `outputEnabled` 初期値 true、`printerLog.warn` は継続。

## design への申し送り（複雑度自己評価）
- 既存構造への状態追加＋WS メッセージ 3 種の追加で、複雑なアーキ判断は無い。**design は不要**、plan で分解する。
- テスト: server（トグルで出力が止まる/再開・警告が履歴に積まれる・owner 制御）、web-ui（トグル表示条件・警告表示）。
