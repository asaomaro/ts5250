# 決定記録

## D1: J・G は常に全角空白、E は DBCS の状態のときだけ、O は変えない
- 測定（2026-09-22・社内機・ACS のコア・930。`scripts/acs-probe/dbcs-space-key.txt`）: G・J は `あ`＋Space＋`い` が `あ　い`・先頭の Space も全角空白（U+3000）。O は SBCS の空白のまま。
  E は空の欄・SBCS の字の後の Space が SBCS の空白、`あ` の後は全角空白。E は最初の字で SBCS か DBCS かが決まり、混ぜられない（`あ` の後の `X`・`X` の後の `あ` は拒否）。
- 決定: `spaceToFullWidth` で、J（`only`）・G（`pure`）は常に U+3000、E（`either`）は編集中の値に全角の字があるときだけ U+3000、O・SBCS は変えない。打鍵の経路だけ（ACS の `processCharKeyStroke`）。
- 「E の状態」は値に全角の字があるかで判定する。空の E に全角空白だけを打つ（IME）と DBCS の状態になる想定だが、その判定は全角空白も全角の字として数える。

## D2: E 欄で SBCS と DBCS を混ぜる規則は別の差として残す
- 測定で、ACS の E は混ぜられないと分かった（`あ` の後の `X`・`X` の後の `あ` は拒否される）。当 PJ の E は混ぜられる。台帳に残した。
