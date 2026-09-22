# 要件: Ctrl+Home（罫線）・Ctrl+F11（カーソルの形）を既定のキーにする（ACS の既定と同じ）

## 背景 / 課題
- 台帳「キー編集の細部」の R11 (h) の残り。ACS の既定の割り当て（`AcsMapFunctions.MAP_5250`）は `C36 = [rule]`（Ctrl+Home）・`C122 = [altcsr]`（Ctrl+F11）。当 PJ には機能（`view:ruleLine`・`view:cursorShape`）があるが既定のキーが無い。

## 目的 / ゴール
- ACS で使い慣れた Ctrl+Home・Ctrl+F11 が最初から効く状態。

## ユーザーストーリー
- US1: ACS から移る利用者として、Ctrl+Home で罫線・Ctrl+F11 でカーソルの形を切り替えたい。なぜなら、キー設定を開かずに済むから。（受け入れ: AC1〜AC2）

## スコープ
### 対象
- 既定の割り当て（`keybindings.ts` の版 5 の追加）。
### 対象外
- Alt+Pause（Test Request）・Ctrl+Z（取り消し）・矩形の移動などの未対応の機能。

## 完了条件 (受け入れ基準)
- [ ] AC1: 新規の利用者に Ctrl+Home＝罫線・Ctrl+F11＝カーソルの形が入る。押すと順送りが呼ばれ、ホストへ送らない。
- [ ] AC2: 版 4 の保存済みの割り当てには追加分だけを足し、使用中のキーは奪わない。各分岐を外すとテストが落ちる（`verify-by-mutation`）。
