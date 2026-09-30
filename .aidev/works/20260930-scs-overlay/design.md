# 仕様: SCS の重ね打ち・罫線・半分の幅

## 概要
桁の格子（`lines`）は変えず、格子に載らないものを `LogicalPage.decor`（行ごと）へ持ち、描く 3 か所が行の箱に重ねて描く。

## 設計方針
ACS の JPS は位置決めして描く（格子ではない）。**構造の側を疑い**、格子に加えて層を持つ（格子の字・検索・コピーは従来どおり）。

## 対象範囲
- `packages/scs`（`scs.ts`・`report-line.ts`・`spool-html.ts`・`index.ts`）、`packages/web-ui`（`ReportText.vue`）、`packages/server`（`pdf.ts`）

## 依拠する既存の事実
- SO/SI の印も行の箱に `position:absolute` で重ねている（`spool-html.ts` の `markHtml`・`ReportText.vue` の `.so`）
- 画面・配布 HTML は同じ関数（`report-line.ts`）で行を分ける
- サーバー・hostserver は `LogicalPage` をそのまま渡し、フィールドを作り直さない（`shifts` を触るのは `ReportText.vue` だけ）

## インターフェース / データ構造
- `RowDecor { glyphs?: OverGlyph[]; h?: HRule[]; v?: VRule[] }`、`LogicalPage.decor?: (RowDecor | undefined)[]`（無いときは持たない）
- `OverGlyph { x（0 起点の桁の境目・小数可）; text; scale（1 か 0.5）; raw? }`
- `HRule { x1; x2; dotted; weight }`（行の下端）、`VRule { x; dotted; weight }`（行を貫く）

## 振る舞いの詳細
- 重ね打ち: 空白でも継続桁でもない字を上書きするたびに、先の字を層へ（同じ字も）
- 半分の幅: `widthScale < 1` か半桁の位置なら格子に置かず層へ。空白は進むだけ
- DGL: JPS の順（縦線の溜め・`canClear`・ページで捨てる）。位置は現在の字幅（SCD）で桁へ
- 描く側: 行の箱に重ね、選択・コピーに入れない

## エラー処理 / 異常系
- 不正な DGL（長さ・種類・選択）は命令ごと無視（ACS と同じ）

## 受け入れ基準との対応
- AC1: `scs.ts` の `stash`（`put`・`putWide`）と `scs-overlay.test.ts`
- AC2: `scs.ts` の `dgl`・`flushV`・`skip2b` と `scs-overlay.test.ts`
- AC3: `scs.ts` の `overlay`・`widthScale` と `scs-overlay.test.ts`
- AC4: `spool-html.ts`・`ReportText.vue`・`pdf.ts` と各テスト
