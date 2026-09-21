# 決定記録

## D1: 「signed-num は ADJUST 指定より優先される」を破棄した
- 背景: `applyAdjust` は tn5250（signed-num の `mand_fill_type` を無条件で `RIGHT_BLANK` へ差し替える）・tn5250j を根拠に、符号付き数値を RZ・RB より先に見て空白右寄せしていた。既存テスト「signed-num は ADJUST 指定より優先される」が固定していた。
- 決定: RZ・RB を先に見て埋め字を決める（RZ は `'0'`・RB は空白）。符号付きなら符号桁を動かさない。RZ・RB が無く符号付きのときだけ従来の空白右寄せ。
- 破棄した根拠: **実機の ACS のコア**（既存の実測 `scripts/acs-probe/field-minus-numeric-only.txt` の M1・M2。2026-09-21・社内機）——`CHECK(RZ) 6 0`（符号付き＋RZ）に `12` → Field− は `000012-`、素の `6 0` に `34` → `    34-`。
  原典（ACS `performRightAdjustFill`）も、符号付き数値の空白を先に決めてから RB・RZ で上書きする（R11 の `key-edit-rest` (a)）。
- 影響: CHECK(RZ) の数値欄の Field Exit・Field± の見え方と、送る数字桁のバイト（0xF0 か 0x40）が ACS と同じになる。

## D2: 残した差（測ってから）
- 空きの数え方（ACS は右端から連続する NUL だけを空きに数え、打った空白・ホストの 0x40 は数えない。当 PJ は空白も空きと見る）・欄の左に空白が残るときの扱い・DBCS の J・G・E の右寄せ（U+3000 埋め）は、
  編集モデルが NUL と空白を区別しない・実測が無いので台帳に残した。
