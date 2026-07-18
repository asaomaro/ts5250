# 仕様: PDF 作成・自動印刷の結果ステータス表示

## 概要
受信スプールごとに自動出力（PDF 保存・物理印刷）の結果を保持し、WS で配送して画面に表示する。
`handleReport` の戻り値は既にあるが `session-manager` が捨てているため、**結果を拾って状態化**するのが要点。

## 設計方針
- 失敗理由も UI に出すため、`HandleReportResult` に**エラー文言とプリンター名を追加**（warn は従来どおり継続）。
- 状態は `PrinterEntry.outputStatuses`（spoolId → status）に持ち、**受信ごとに WS push ＋ `printer-opened` で既存分を配送**（Q3）。
- 表示は**一覧行に簡易（✓/✗/–）、選択スプールのヘッダに詳細**（Q1 決定）。

## インターフェース / データ構造
```ts
// printer-output.ts（拡張）
interface HandleReportResult {
  pdfPath?: string;  pdfError?: string;
  printed?: boolean; printer?: string; printError?: string;
}

// 共有する状態（server → client）
interface SpoolOutputStatus {
  spoolId: string;
  at: number;
  /** 自動出力が無効でスキップされた */
  skipped?: boolean;
  /** 設定がある場合のみ。ok=false は失敗（error に理由） */
  pdf?: { ok: boolean; path?: string; error?: string };
  print?: { ok: boolean; printer?: string; error?: string };
}

// PrinterEntry（追加）
outputStatuses: SpoolOutputStatus[];   // 受信順・上限 100

// WS
interface WsPrinterOutputResult { type: "printer-output-result"; sessionId: string; status: SpoolOutputStatus }
// printer-opened に outputStatuses: SpoolOutputStatus[] を追加
```

## 振る舞いの詳細
- 出力設定あり＆有効 → `handleReport` の結果から status を作る:
  - `autoPdfDir` あり: `pdfPath` があれば `pdf={ok:true,path}`、無ければ `pdf={ok:false,error:pdfError}`
  - `autoPrint` あり: `printed===true` で `print={ok:true,printer}`、それ以外は `print={ok:false,error:printError}`
  - 設定が無い側は**キーごと省略**（＝「設定なし」を UI が `–` で表現）
- 出力設定あり＆**無効（トグル OFF）** → `{ spoolId, at, skipped: true }` を記録（受信自体は従来どおり）。
- 出力設定なし → status を作らない（UI に何も出さない）。
- 保持上限 100 件（古いものから捨てる）。

## UI（PrinterPane）
- **一覧行**: スプールごとに小さなステータス（`PDF ✓ / 印刷 ✓`、失敗は `✗`、設定なしは `–`、スキップは `⏸`）。
  色は成功=緑・失敗=赤・その他=muted。
- **選択スプールの詳細**: ビューア上部に 1 行で「PDF: 保存先パス / 印刷: プリンター名」または失敗理由を出す。
- 出力設定が無いセッション（`outputConfigured=false`）ではステータス列自体を出さない。

## エラー処理 / 異常系
- 既存の警告バー（`printer-warn`）とサーバーログは**そのまま維持**（失敗の即時通知として併存）。
- status が無いスプール（設定なし・古い上限超え）は UI で何も出さない。

## 受け入れ基準との対応
- 成功/失敗/スキップ/設定なしの 4 状態を status で表現し、一覧＋詳細で表示。
- `printer-opened` で既存分を配送するため、後からタブを開いても見える。

## design 不要（複雑度自己評価）
既存構造への状態追加＋WS メッセージ 1 種で、複雑なアーキ判断は無い。plan で分解する。
