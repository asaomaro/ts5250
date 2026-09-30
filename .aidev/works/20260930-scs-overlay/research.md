# 調査: ACS の JPS の重ね打ち・罫線・半分の幅

## 判明した事実
- F1（原典 `JPSPrintableCharacters.process`・`JPSState`）: 字は 1 字ずつ `drawString` し、位置 x を `charAdvance × widthScale`（DBCS の区間は `wideCharAdvance`）進める。何も消さない＝CR で戻って重ねた字は両方が紙に残る（`ABC` CR `___`）。
- F2（`processDefineGridLines`・`JPSGridLine`・`JPSHorizontalGridLine`・`JPSVerticalGridLine`・`JPSState.addVerticalGridLine`・`clearVerticalGridLines`）: `2B FD len 00 type sel positions…`。len が 2 なら消す・4 より大きい奇数は不正。type は 0 実線細・1 実線太・2 実線二重・8 点線細・9 点線太・10 点線二重（ほかは命令ごと無視）。sel は 0 消す・0x40 縦・0x80 横（位置 2 つで 1 本）・0xC0 両方（縦線を位置ごとに、最初と最後が違えば横線も）。位置は 1/20 pt（`n / 20`）。
  横線は**今の行の下端**に x1〜x2 を引き、その前に溜めた縦線を引く。縦線は溜めておき、**行が変わったあとで**横線か「消す」か次の縦線の追加が来たときに、始まった行の下端から今の行の下端まで引く（`canClear` は Y が変わると立つ）。FF で新しい状態になり、引かれなかった縦線は捨てられる。
- F3（`JPSState`）: 位置（1/20 pt）を桁へ直すには字幅 `charWidth`（10 CPI は 7.2 pt）で割る（`x × charAdvance / charWidth` は桁の座標と等しい）。字幅は SCD（`2B D2 .. 29`）で変わる（`mapCharDistanceToCharWidth`: ≤10 と 255 は 7.2・≤12 は 6.0・≤13 は 5.4・≤15 は 4.8・≤20 は 3.6・それ以外 4.235…）。SPPS でも変わる（`setPageSize`）が当 PJ は追わない（未確認・decisions D1）。
- F4（`JPSFontSizeScaling.mapScalingFactor`）: 横の倍率は 0x20 が 2・0x08 が 0.5・それ以外 1。字の進みに掛かる（1 桁に 2 字）。
- F5（実採取の 2 件）: DSPLIBL の SBCS・DBCS の帳票を復号し直しても decor は付かない＝従来の帳票は 1 文字も変わらない。
- F6（合わせない理由 ①）: 最後の FF が無いジョブは、ACS の `close()` が `m_pages` だけを印刷するので最後の FF より後を印刷しない＝情報を捨てる。
- F7（合わせない理由 ②）: SIT の無い DBCS は、JPS の状態の初期値が `charAdvance=18.0`（10 CPI の進み）に対し `wideCharAdvance=7.2`（全角は 14.4＝0.8 桁）で、SIT（`JPSDBCSCharacterDistance`）が来て初めて全角が 2 桁ぶんになる。既定値のまま全角が 0.8 桁に詰まる。桁の格子の意味が変わるので写さない。

## 実装アンカー
- A1: `packages/scs/src/scs.ts`（`put`・`putWide`・`stash`・`overlay`・DGL・`skip2b`）
- A2: `packages/scs/src/report-line.ts`（`overGlyphView`・`ruleLook`）・`spool-html.ts`（`decorHtml`）
- A3: `packages/web-ui/src/components/ReportText.vue`・`packages/server/src/pdf.ts`
