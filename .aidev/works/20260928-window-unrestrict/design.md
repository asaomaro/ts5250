# 仕様: WDSF 0x52

## 概要
0x52 を `unrestrict-cursor` の事象として読み、中身の長さを検査して、直近の窓の `restrictCursor` を下ろす。

## 設計方針
- `parseWdsf`: `{ kind: "unrestrict-cursor", bodyLength }`
- `applyWdsf`: `bodyLength !== 2` なら `SENSE.WDSF_LENGTH`、そうでなければ `buf.unrestrictWindowCursor()`
- `ScreenBuffer.unrestrictWindowCursor()`: `guiWindows` の最後の窓（ACS の `enpwindow`＝最後に作った窓）

## 対象範囲
- `wdsf-parser.ts`・`wtd-applier.ts`・`buffer.ts`、単体テスト、DSM・プローブ・実機スクリプト

## 依拠する既存の事実
- research F1〜F3。画面の側の閉じ込めは `restrictCursor` を見るだけ（`packages/web-ui/src/components/EmulatorPane.vue`）なので web-ui は変えない

## インターフェース / データ構造
- `WdsfEvent` に `unrestrict-cursor`・`ScreenBuffer.unrestrictWindowCursor()`

## 振る舞いの詳細
- 窓が無ければ何もしない（否定応答もしない。ACS も `enpwindow` が null なら何もしない）

## エラー処理 / 異常系
- 長さの誤りは 0x10050110（WTD を打ち切る。既存の WDSF の否定応答と同じ道）

## 受け入れ基準との対応
- AC1: 単体・`scripts/verify-window-unrestrict.mjs`
- AC2: 単体・同スクリプト（CPFA304）
