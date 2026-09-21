# 設計: 関連付けの監査

## 概要
- `prepareAssociation` を、指定の有無の判定と監査を持つ外側と、起こす本体（`startAssociatedPrinter`）に分ける。外側は本体の結果から `audit({ op: "ws_associated_printer", result, code?, durationMs })` を 1 回出す。

## 対象範囲
- `packages/server/src/ws-handler.ts`、`packages/server/test/ws-associated-printer.test.ts`。

## 依拠する既存の事実
- `prepareAssociation` の戻り値の `issue`（`ws-handler.ts`）・`audit()`（`audit.ts`）・`setAuditSink`（テスト用の差し替え）。

## インターフェース / データ構造
- 監査イベント: `{ op: "ws_associated_printer", result: "ok" | "error", code?: "invalid" | "failed" | "timeout", durationMs }`。名前・装置名は載せない。

## 振る舞いの詳細
- 関連付けの指定が無ければ何も記録しない。指定があれば、準備の成否によらず 1 件。`issue` が無ければ `ok`、あれば `error` と `code`。

## エラー処理 / 異常系
- 準備が例外を投げる場合は無い（内部で `error` を `issue: "failed"` に直している）。

## 受け入れ基準との対応
- AC1: 成功で `ok` を 1 件。
- AC2: `issue` を `code` に載せる（invalid・failed・timeout の 3 経路）。
- AC3: 指定が無ければ `audit` を呼ばない。
- AC4: イベントに載せるのは種別・結果・時間だけ。テストで各経路と mutation。
