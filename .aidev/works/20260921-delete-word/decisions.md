# 決定記録

## D1: Delete Word の範囲は実機の ACS の測定どおり
- 測定（2026-09-22・社内機・ACS のコア・930。`scripts/acs-probe/delete-word.txt` の a〜l・d1〜d8、`continued-field-erase-exit.txt` の B8）: 空白の上は 1 字（空白が続いても 1 字ずつ）、全角は 1 字ずつ。
  半角の語は、頭（直前が空白・全角・欄の先頭）なら語＋続く空白、途中ならカーソルから語の終わりまで。語の終わりは空白・全角・欄の終わり。記号は語の一部（区切りは空白だけ）。継続欄は鎖を 1 つの欄として数える（`1234/56/78` の 1 区間目の 2 桁目で `1   /  /  `）。
- 決定: `deleteWordLength`（純関数）が長さを返し、SBCS は `del` と同じく詰めて欄の長さを保つ。DBCS は論理値から削って `padDbcs`。継続欄は `editAcrossContinued`。カーソルは動かさず、欄も出ない。MDT は消えるものが無くても立てる（`processDeleteWord` は `processDeleteChar(n, true)`）。

## D2: 既定は ACS と同じ（Ctrl+Delete＝Delete Word・Ctrl+Backspace＝割り当て無し・Erase EOF＝既定キー無し）
- 原典: ACS `AcsMapFunctions.MAP_5250` は `C127 = [deleteword]`・`C8` 無し・Erase EOF の既定無し（Erase Input は `A35`＝Alt+End）。
- ~~`20260729-field-adjust-local-edit-keys` の「Ctrl+Delete＝Erase EOF・Ctrl+Backspace＝Erase Input」~~ を破棄した（ACS の裏づけが無く、語を消す習慣で押すと欄の残りや全欄が消えるため。AGENTS.md 判断の原則 1・3）。README も直した。
- 保存済みの割り当て: `ADDED_BY_VERSION[2]` の ctrl+Delete を `local:delete-word` にし ctrl+Backspace を外す。`CORRECTED_BY_VERSION[5]` を**キーごとに独立した訂正の配列**へ作り替え（版 4 の Ctrl+F1/F3 の訂正も配列の 1 件へ）、`to` の値が `null` なら割り当てを外す。
  古い既定（Ctrl+Delete＝Erase EOF・Ctrl+Backspace＝Erase Input）のままの人だけが移る。自分で変えた値・消した割り当ては壊さない（ctrl+Delete を版 5 の追加にすると消した人へ復活するので、版 2 の値の差し替えにした）。
  `BINDINGS_VERSION` は訂正だけの版も数える。

## D3: Delete Word は操作員エラー中も拒否しない
- 測定: 先頭の Backspace（0005）の後、`[delete]` は inhibit=5・値そのまま（拒否）。`[deleteword]` は inhibit=0 で語を消した。原典 `PS5250.keyDown` の拒否の一覧（Backspace・Erase EOF・Erase Input・Erase Field・Delete・Field±・Field Exit・Dup・Field Mark・文字）に `[deleteword]`（63623）は無い。
- 決定: `isEditingKey` は `delete-word` を拒否せず、エラーを抜けてから働かせる。~~ローカル編集キーはすべて拒否~~（`20260921-operator-error-mode` の一般化）は Delete Word には当たらない。

## D4: 割り当ての無い修飾付き Backspace・Delete は何もしない
- 背景: Ctrl+Backspace を未割り当てにすると、ブラウザの既定（語の削除）が <input> の値だけを書き換え、編集モデルとずれる（以前は Erase Input が割り当たっていて止まっていた）。
- 決定: 欄の keydown（SBCS・DBCS）で、修飾付きの Backspace・Delete で `hasKeyBinding` が偽なら preventDefault して何もしない。ACS の Ctrl+Backspace も何も起きない。

## D5: 測っていないもの（未確認）
- 欄内の選択があるときの `[deleteword]`（当 PJ は選択に触れない。ACS の Delete 系は選択に触れない）。NUL を空白と数えるか（当 PJ は空白 `" "` だけ。編集値に NUL は現れない）。J・G・E の欄の Delete Word（O だけ測った。原典は同じ規則）。
