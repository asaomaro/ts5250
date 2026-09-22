# 仕様: 欄の先頭の Backspace

## 設計方針
- ScreenGrid の SBCS の欄（と行をまたぐ欄の並びの先頭）で、`field-prev` の代わりに `MSG_PROTECTED`（0005）を出す。操作員エラーに入るのは既存の経路（`isOperatorError`）。
- DBCS の欄は従来のまま（`field-prev`）。注記に 0101 と未確認を書く。

## 依拠する既存の事実
- `MSG_PROTECTED` は操作員エラー（文字・Backspace・Delete を拒否。`20260921-operator-error-mode`）。

## 受け入れ基準との対応
- AC1: `field-boundary-backspace.test.ts`・`continued-field-edit.test.ts`
- AC2: 同（途中の Backspace・中間区間の先頭）
- AC3: mutation
