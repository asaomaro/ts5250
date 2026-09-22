# 決定記録

## D1: 「signed-num は ADJUST 指定より優先される」を破棄した
- 背景: `applyAdjust` は tn5250（signed-num の `mand_fill_type` を無条件で `RIGHT_BLANK` へ差し替える）・tn5250j を根拠に、符号付き数値を RZ・RB より先に見て空白右寄せしていた。既存テスト「signed-num は ADJUST 指定より優先される」が固定していた。
- 決定: RZ・RB を先に見て埋め字を決める（RZ は `'0'`・RB は空白）。符号付きなら符号桁を動かさない。RZ・RB が無く符号付きのときだけ従来の空白右寄せ。
- 破棄した根拠: **実機の ACS のコア**（既存の実測 `scripts/acs-probe/field-minus-numeric-only.txt` の M1・M2。2026-09-21・社内機）——`CHECK(RZ) 6 0`（符号付き＋RZ）に `12` → Field− は `000012-`、素の `6 0` に `34` → `    34-`。
  原典（ACS `performRightAdjustFill`）も、符号付き数値の空白を先に決めてから RB・RZ で上書きする（R11 の `key-edit-rest` (a)）。
- 影響: CHECK(RZ) の数値欄の Field Exit・Field± の見え方と、送る数字桁のバイト（0xF0 か 0x40）が ACS と同じになる。

## D2: 残した差（測ってから）
- ~~空きの数え方（ACS は右端から連続する NUL だけを空きに数え、打った空白・ホストの 0x40 は数えない。当 PJ は空白も空きと見る）・欄の左に空白が残るときの扱い~~ →
  節目 11 の独立点検（B-S6）で D3 のとおり直した。DBCS の J・G・E の右寄せ（U+3000 埋め）は測っていないまま残した（台帳）。

## D3: `rightAdjust`（GNU tn5250 `tn5250_display_shift_right` の移植）を破棄し、ACS `performRightAdjustFill` の規則へ書き換えた
- 背景: 節目 11 の独立点検（B-S6）で、空の RZ/RB 欄を Field Exit しても当 PJ は何も整形しないことが分かった（原典の無限ループ回避という下位の根拠に頼っていた。AGENTS.md 判断の原則 1・3）。
- 決定: `rightAdjust` の空き判定を「全桁が空白なら整形しない」から「カーソル以降（＝ Field Exit が直前に消した桁数）だけが空き」に書き換えた。打った空白・ホストの空白は内容として右へ動く。
- 破棄した根拠: **実機の ACS のコア**（`scripts/acs-probe/empty-adjust-field-exit.txt`。2026-09-22・社内機）——何も打たずに欄の先頭で Field Exit すると全桁が埋め字（`CHECK(RZ)` の空の欄が `000000`。ホストが受け取った値も `000000`）。
  空の欄の途中（5 桁目）で Field Exit すると `00    `・2 桁目で `00000 `（手前の空白は内容として一緒に右へ動く）。`1` と空白を打って Field Exit すると `00001 `（打った空白は空きとして捨てない）。符号付き＋RZ を空のまま Field Exit すると `000000 `（符号桁は空白のまま）。
  原典 `PS5250.performRightAdjustFill` も「欄末尾から続く NUL の数」だけを空きとして数える（`TextPlane[n2] == '\u0000'` のループ）。
- 影響: `applyAdjust`／`fieldExit`／`fieldSign` の呼び出し側は変更なし（`rightAdjust` の内部規則だけを差し替えた）。既存の「末尾が非空白なら無変化」「語中の空白は保持」の性質は保たれる。
  **これは「ACS が情報を捨てている」例外（AGENTS.md 判断の原則 1）ではない**——ACS の方が細かい規則（NUL と空白の区別）を持っており、GNU tn5250 の実装が単純化（全空白の欄は何もしない）していた側。
