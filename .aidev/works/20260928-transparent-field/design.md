# 仕様: 透過の欄

## 概要
FCW 0x84xx で欄に `transparent` を立て、送信の 2 つの形で ACS と同じバイト列を組む。

## 設計方針
- `applySf`: `(fcw & 0xff00) === 0x8400` で `transparent`。`addField` の引数に足し、`InternalField.transparent` に持つ（立つときだけ）
- `transparentBytes(buf, f, codec)`: 欄の全桁（継続欄は全区間）を 1 桁ずつ。空のセルは 0x00、センチネルは生バイト、字は符号化
- `buildFieldResponse`: 透過なら `0x10`・長さ（2 バイト）・`transparentBytes`
- `buildFlatFieldResponse`: 透過なら `transparentBytes` をそのまま（詰め・符号の加工をしない）

## 対象範囲
- `wtd-applier.ts`・`buffer.ts`・`read-response.ts`、単体テスト、DSM の TRANSP・プローブ・実機スクリプト

## 依拠する既存の事実
- research F1・F2・F3
- SAVE SCREEN の応答の SF は DBCS の FCW しか書かない（`save-screen.ts` の `writeScreenAsWtd`）が、復元は預けた画面から戻すので透過は失われない（`session.ts` の `attachSaveContext`）

## インターフェース / データ構造
- `InternalField.transparent?: boolean`・`addField(..., transparent = false)`

## 振る舞いの詳細
- snapshot には出さない（打鍵の規則は普通の欄と同じ）

## エラー処理 / 異常系
- なし

## 受け入れ基準との対応
- AC1: `buildFieldResponse` の分岐（単体・`scripts/verify-transparent-field.mjs`）
- AC2: `buildFlatFieldResponse` の分岐（単体）
