# 要件: Ctrl+Delete を Delete Word にし、Ctrl+Backspace の既定を外す（ACS の既定と同じ）

## 背景 / 課題
- 台帳「キー編集の細部」の調査（R11・`key-edit-rest` (h)）。ACS の既定のキー割り当て（`AcsMapFunctions.MAP_5250`）は `C127 = [deleteword]`（Ctrl+Delete＝カーソルの語を消す）で、`C8`（Ctrl+Backspace）の割り当ては無く、
  Erase EOF の既定キーも無い（Erase Input は `A35`＝Alt+End）。当 PJ は Ctrl+Delete＝Erase EOF・Ctrl+Backspace＝Erase Input を既定にしていた（`20260729-field-adjust-local-edit-keys`。ACS の裏づけは無い）。
  語を消す習慣で押すと、欄の残りや**全欄が消える**。
- 実機の ACS のコアで `[deleteword]` を測った（`scripts/acs-probe/delete-word.txt`・`continued-field-erase-exit.txt` の B8。コマンド行・DBCSFE の O 欄・DTMPGM の日付欄）:
  語頭は語＋続く空白、語の途中はカーソルから語の終わりまで、空白の上と全角は 1 字、記号は語の一部（区切りは空白だけ）、全角の直後の半角は語頭、半角の語は全角で止まる、継続欄は鎖を 1 つの欄として数える。
  操作員エラーの間、`[delete]` は拒否されるが `[deleteword]` はエラーを抜けて語を消す。

## 目的 / ゴール
- Ctrl+Delete で ACS と同じ範囲の語が消え、Ctrl+Backspace で何も消えない（全欄が消えない）状態。既存利用者の保存済みの割り当ては、古い既定のままの人だけが新しい既定へ移る。

## ユーザーストーリー
- US1: ACS から移る利用者として、Ctrl+Delete で語を消せ、Ctrl+Backspace を押しても欄が消えないでほしい。なぜなら、語を消すつもりで全欄を消すと入力をやり直すことになるから。（受け入れ: AC1〜AC5）

## スコープ
### 対象
- Delete Word（ローカル編集キー `local:delete-word`）の新設と、既定の割り当て（Ctrl+Delete）。Erase EOF・Erase Input の Ctrl 系の既定の撤去。保存済みの割り当ての移行。操作員エラー中の扱い。README。
### 対象外
- Alt+←/→（`[backtabword]`・`[tabword]`）と語頭の定義、`¬ ¢ £` の Alt 入力、Ctrl+Home（罫線）・Ctrl+F11（カーソル形）、Alt+Pause（Test Request）は別の差（台帳に残す）。

## 完了条件 (受け入れ基準)
- [ ] AC1: Ctrl+Delete（既定）が Delete Word を実行し、範囲が ACS と同じ（語頭・途中・空白・記号・全角・全角の隣・欄の端・継続欄）。欄は出ず、カーソルは動かない。MDT は消えるものが無くても立つ。
- [ ] AC2: 操作員エラー中も拒否せず、エラーを抜けて語を消す（Delete など他の編集キーは従来どおり拒否）。
- [ ] AC3: Ctrl+Backspace は何もしない（Erase Input を実行しない・ブラウザの語削除で欄の見た目だけが変わらない）。Erase EOF は既定のキーが無く、割り当てれば効く。
- [ ] AC4: 保存済みの割り当てが古い既定のままの人（版 2〜4）だけ、Ctrl+Delete は Delete Word へ・Ctrl+Backspace は外れる。自分で変えた値・消した割り当ては壊さない。
- [ ] AC5: 各分岐を外すとテストが落ちる（`verify-by-mutation`）。
