# 決定記録

## D1: 継続欄の Erase EOF・Field Exit・Field+ は続く区間を全桁消し、Dup は全桁 Dup 文字で埋める
- 測定（2026-09-22・社内機・ACS のコア・930・拡張 5250 を申告。`scripts/acs-probe/continued-field-erase-exit.txt`）: DTMPGM の日付欄（4/2/2）で `12345678` を打ち、
  最初の区間の 2 桁目の Erase EOF → `1   /  /  `（B1）、2 区間目の途中 → `1234/5 /  `（B1b）、Field Exit も同じ消去（B2・B4・B5）。
  DUP 可の継続欄（ULKPGM の CDUP）の Dup は、カーソルの区間はカーソルから、続く区間は全桁が 0x1C（B3・B3b）。
- 決定: `fillFollowingSegments` で、カーソルの区間より後ろの区間を全桁 `fill`（空白・Dup 文字）で直接コミットする。カーソルの区間は従来の編集モデルのまま。
  右寄せ（`applyAdjust`）はカーソルの区間だけ（ACS `performRightAdjustFill`。この日付欄は右寄せの指定が無く、`5 ` のまま）。
- 満杯直後の Field Exit（`fieldExited`）は ACS が `eraseToEOF` を通らないので消さない（`erases`）。ただし続く区間を持つ区間に「出た」状態は付かない（下の mutation の等価変異）。

## D2: 欄を出る操作（Field Exit・Field±・Dup）の行き先は継続欄の鎖の後ろ
- 測定: Field Exit の後のカーソルは、1・2・最後のどの区間からでも、画面の最後の欄なら最初の入力欄（3,24）（B2・B4・B5）、画面の途中の鎖なら次の欄（21,24。B6・B7）。次の区間（23,29・20,29）ではない。Dup も次の欄（9,24。B3）。
- 決定: `field-full` に第 3 引数 `leaving` を足し、`EmulatorPane.vue` の `indexAfterLeaving`（継続欄の 2 区間目以降を飛ばし、無ければ先頭へ巡回。ACS `nextNonByPassInputFieldPos`）で行き先を決める。
  打鍵で満杯になったときの自動送りは ACS も次の区間へ進むので、`leaving` を付けず従来どおり。ホストの指定したカーソル送り（`progressionStop`）は従来どおり最優先。
- `viaFieldExit`（出た後の検査を掛けない印）と `leaving` は別: Dup は出た後の検査を掛ける（従来どおり）が、行き先は鎖の後ろ。

## D3: 測っていないもの（未確認）
- DBCS の継続欄・CNTFLD の複数行欄（EDTMSK の日付欄だけ測った。原典の規則は同じ）。カーソル送り（FLDCSRPRG）を持つ鎖の行き先（当 PJ は従来どおり `progressionStop` が先）。
