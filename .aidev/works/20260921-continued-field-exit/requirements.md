# 要件: 継続欄の Erase EOF・Field Exit・Field±・Dup を ACS と同じにする

## 背景 / 課題
- 台帳「キー編集の細部」の調査（R11・`key-edit-rest` (b)）。継続欄（EDTMSK で割られた日付欄・CNTFLD の複数行欄。`Field.continued`）は、ACS では並び全体で 1 つの入力欄。
  当 PJ は Erase EOF・Field Exit・Field±・Dup を**カーソルの区間だけ**に掛け、欄を出る行き先は**次の区間**にしていた（Backspace・Delete・挿入は既に区間をまたぐ）。
- 実機の ACS のコアで測った（`scripts/acs-probe/continued-field-erase-exit.txt`。DTMPGM の日付欄 4/2/2 と、DUP 可の継続欄〔`scripts/build-ulktest.mjs` の CDUP〕・930・拡張 5250 を申告）:
  (1) Erase EOF・Field Exit は最初の区間の 2 桁目から `1234/56/78` を `1   /  /  `（続く区間は全桁消える）、2 区間目の途中なら `1234/5 /  `。
  (2) Field Exit の後のカーソルは、1・2・最後のどの区間からでも**鎖の後ろ**（次の欄・無ければ画面の最初の入力欄）で、次の区間ではない。
  (3) Dup は、カーソルの区間はカーソルから、続く区間は全桁が Dup 文字（0x1C）になり、カーソルは鎖の後ろの欄へ。

## 目的 / ゴール
- 継続欄の Erase EOF・Field Exit・Field±・Dup が、ACS と同じ範囲を消す・埋め、欄を出た後のカーソルが ACS と同じ場所に着く状態。

## ユーザーストーリー
- US1: ACS から移る利用者として、日付欄やメモ欄の途中で Erase EOF・Field Exit を押したら、その後ろの区間まで消え、次の欄へ進んでほしい。なぜなら、日付の 2 区間目に入り込んで手が止まるから。（受け入れ: AC1〜AC4）

## スコープ
### 対象
- ScreenGrid の Erase EOF・Field Exit・Field±・Dup（続く区間の消去・埋め）と、EmulatorPane の欄を出る行き先。
### 対象外
- 打鍵で満杯になったときの自動送り（ACS も次の区間へ進む）。Field− の継続欄での拒否（従来どおり）。DBCS の継続欄（EDTMSK は数値欄で、DBCS の継続欄は測っていない）。

## 完了条件 (受け入れ基準)
- [ ] AC1: 継続欄の Erase EOF は、カーソルの区間はカーソルから、続く区間は全桁を消す。最後の区間ではその区間だけ。
- [ ] AC2: Field Exit・Field+ も同じ消去をし、右寄せはカーソルの区間だけ。
- [ ] AC3: Dup は続く区間の全桁を Dup 文字で埋める。
- [ ] AC4: 欄を出る操作（Field Exit・Field±・Dup）の行き先は継続欄の鎖の後ろ。鎖が最後の欄なら画面の最初の入力欄へ巡回。継続欄でない欄・自動送りは変えない。各分岐を外すとテストが落ちる（`verify-by-mutation`）。
