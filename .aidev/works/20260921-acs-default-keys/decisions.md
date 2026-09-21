# 決定記録

## D1: End を Erase EOF にする割り当て（この work の途中で入れかけた）を破棄する

- 背景: 着手時に `B35` を Erase EOF と読み、版 4 に `End: local:erase-eof` を入れて関係テストを書き換えかけた。
- 決定: 原典で `[eof]`（1001）と `[eraseeof]`（63739）が別物で、`[eof]` は `processEndField`（欄の末尾へ移る）だと確かめた（research F3）。End には何も割り当てない。
  当 PJ の割り当て無しの End が既にそれに当たる。

## D2: Ctrl+F1 / Ctrl+F3 の既定を ACS の向きへ直す（`4a3a575b` の決定を破棄）

- 背景: `4a3a575b` は「ACS で使い慣れた表示切り替え」として Ctrl+F1 = カナ英・Ctrl+F3 = SO/SI を入れたが、原典の確認が無い。
- 決定: ACS は `C112 = [dspsosi]`・`C114 = [altview]`（research F6）。新しい既定は ACS の向きにし、版 4 より前の保存値は組が丸ごと古い既定のときだけ入れ替える。
- 代替案: 片方ずつ直す——片方だけ消した人は、残した方の意味が変わってしまう。直さない——以前から使っている人だけ ACS と逆のまま残る。

## D3: Esc で選択を解くだけにはしない

- ACS の既定の表に Esc で選択を解く割り当ては無く（HOD の `Map5250` にある `S27 = [unmark]` も ACS では SysReq）、Esc はそのまま Attn。
  当 PJ は Esc で矩形選択を解いたうえで Attn を送る。ACS の GUI で選択中に Esc を押したときに選択が残るかは**未確認**（GUI を使わないコアでは測れない）。

## D4: Ctrl+Pause は `Pause` と `Cancel` の両方に割り当てる

- ブラウザは Ctrl+Pause を `Cancel`（Ctrl+Break）として報告することがある。どちらで届くかは**未確認**（実ブラウザ・実キーボードで確かめていない）。
