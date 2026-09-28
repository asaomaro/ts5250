# 仕様: 再順序付け

## 概要
バッファに再順序付けの番号と欄ごとの次の番号を持ち、READ の応答の欄の並びを鎖で作る。

## 設計方針
- `ScreenBuffer.resequenceFirst`（0 = なし）: `setHeaderData` で本体の長さ 3 以上なら本体 3 バイト目、`clearFormatTable`・`clearUnit`・`clearUnitAlternate` で 0
- `InternalField.nextResequence`（FCW 0x80nn の nn。立つときだけ）
- `ScreenBuffer.readMdtFields()`（READ MDT 系）・`readInputFields()`（平たい形）: 再順序付けが 0 なら従来（`mdtFields()` / `orderedFields()`）、そうでなければ F2・F3 の鎖。
  番号は欄の表の順（`orderedFields()`＝番地の順。ACS の表は定義の順だが、昇順でない SF は表に入らないので同じ）の 1 始まり。範囲外の番号・一巡は終わりにする（ACS は例外）。
  MDT 系の n=0（ACS は例外）も終わりにする
- `fieldAddFailure`: カーソル送りの欄は `resequenceFirst !== 0` なら断る

## 対象範囲
- `buffer.ts`・`wtd-applier.ts`・`read-response.ts`、単体テスト、DSM の RESEQ・プローブ・実機スクリプト

## 依拠する既存の事実
- research F1〜F6
- 平たい形の門番（`buf.mdtFields().length > 0`）はそのまま（`read-response.ts` の `buildFlatFieldResponse`）

## インターフェース / データ構造
- `resequenceFirst: number`・`nextResequence?: number`・`readMdtFields()`・`readInputFields()`

## 振る舞いの詳細
- 継続欄の MDT は並びで見る（`mdtFields()` と同じ判定を使う）

## エラー処理 / 異常系
- 範囲外の番号・循環: 終わり（ACS は例外で送れない。当 PJ は途中まで送る——差として記録）

## 受け入れ基準との対応
- AC1: `readMdtFields`（単体・`scripts/verify-resequence.mjs`）
- AC2: `readInputFields`（単体）
- AC3: `fieldAddFailure`・リセット（単体）
