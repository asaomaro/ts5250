# 調査: 制御バイトの扱い

## 判明した事実
- F1: ACS の `processWriteToDisplay` の switch は 10 オーダーだけ。それ以外（ESC を除く）は 1 続きの文字列として `writeString` する（R11 の `neg-order` §2.4・`20260915-acs-protocol-order-audit` research Q2 も同じ読み）。
- F2: **実機の ACS のコア**（DSM の試験プログラム `CTLBYTES`。2026-09-22・社内機・930）: `A<05>B<06>C<07>D<08>E<09>` は `A B C␡D E`（0x07 だけ DEL）、0x0A〜0x0D・0x16〜0x1B も 1 桁の空白、`R<1F>S<00>T` は `R█S T`（0x1F は塗り潰し）。SBA・SF・IC は全部処理された（カーソルは IC の位置）。
- F3: **当 PJ**（同じ画面。`DIAG_SCREEN=1 scripts/diag-5250-commands.mjs CTLBYTES`）: `unknown order 0x5 — skipping to next command` と警告し、3 行目は `A` だけ・後ろの SBA・SF・IC は失われ、カーソルは動かなかった。

## 実装アンカー
- A1: `applyWtd`（`packages/tn5250/src/protocol/wtd-applier.ts`）の主ループの `switch`——`default:`（未知オーダー）を、制御バイトの表示データの分岐に置き換える。
- A2: `packages/tn5250/src/protocol/constants.ts`——`isKnownCommand`（`default:` の復旧でだけ使っていた）を、`isControlData`・`controlDataText` に置き換える。
