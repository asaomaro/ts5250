# 決定記録

## D1: MF は Field Exit の前にも見る（欄を出た後の検査は残す）

- ACS は Field Exit では消去・右寄せの前に止める（値を変えない）。当 PJ の欄を出た後の検査（`EmulatorPane.vue`。Tab・矢印・クリック用）は消去の後なので、
  カーソルの後ろを消してから戻していた。Field Exit・Field± では前に見て止め、他の経路は従来どおり出た後に見る。
- ~~「欄を出た後の検査は残す」~~ → 節目 10 の独立点検 B-S5 で**Field Exit・Field± では出た後の検査（MF・自己点検）を掛けない**ことに改めた
  （`EmulatorPane.vue` の `onFieldFull` と `muteLeaveCheckThroughKeyMove`）。ACS の `processFieldPlusMinusAndExit` は出た後の検査を呼ばない（javap）。
  実機の ACS のコアで、検査桁の合わない自己点検欄（5 桁）の Field Exit は通り、Tab は検査数字エラーになった（`scripts/acs-probe/selfcheck-field-exit.txt`）。
  Dup・満杯の自動送りは従来どおり出た後に見る。

## D2: ME の Field Exit の文言は当 PJ で書いた

- ACS の文言（research F2）を写さず意味で書き、「先頭で押すと止まる」ことが分かるよう出方を添えた。

## D3: 字を置いたら同じ値でも編集を出す（節目 9 の独立点検）
- 背景: 編集は「値が変わったとき」だけ出していた（カーソル移動で MDT にしないため）。ACS は字を置けば値が変わらなくても `setMDT` する（`PS5250.inputChar` / `insertChar`）。
- 決定: 打鍵・DBCS の打鍵・ペースト・IME の確定で字を 1 つでも置いたら、同じ値でも編集を出す（`ScreenGrid.vue` の `charPlaced`〔現在の名は `mdtKeyed`〕）。カーソル移動は従来どおり MDT にしない。
- 影響: 同じ字を打ち直した欄も READ MDT で送られる（ACS と同じ）。右寄せ欄の 0020 の待ちも付く。
- 範囲の訂正（節目 10 の独立点検 B-S2）: この決定は「ペースト」と広く書いたが、実装は **DBCS 欄の単一行の貼り付けだけ**で、SBCS 欄への貼り付け（主経路。`pasteFrom`）は**同じ値のペーストで MDT が立たなかった**。
  貼った字は ACS `pasteRect` が 1 字ずつ `insertChar`/`inputChar` へ渡すので（`setMDT` つき）、主経路・単一行・DBCS の各経路で立てるようにした（`ScreenGrid.vue` の `mdtKeyed`）。
  継続欄をまたぐ Backspace・Delete は実際に値が動いたときだけ（B-M1・`field-exit-checks-wiring.test.ts`）。

## D4: 編集の印 `mdtKeyed` は、字を置く・消す編集キー全般で立てる。実機の ACS のコアで測った（節目 10 の独立点検 B-S2・B-S3）
- 測定（2026-09-22・社内機・ACS のコア。`scripts/acs-probe/erase-eof-mdt.txt`）: ME の欄（MDT なし）で、値が変わらない編集キー（空の欄の Erase EOF・欄の空白の桁の Delete・Backspace）のあと、欄の先頭でない位置で Field Exit すると、いずれも通った（MDT が立った）。
- 決定: 打鍵・DBCS の打鍵・IME・貼り付け（SBCS の主経路を含む）・Backspace・Delete・Erase EOF・Field Exit の消去で、値が変わらなくても編集を出す。カーソルの移動だけでは出さない。
- 未確認（テストで固定していない）: 選択を Backspace・Delete で消すとき。ACS のコアの `clearRect` は空白だけの範囲では `inputChar` を呼ばず MDT を立てないが、キーがそこへ繋がるかは GUI 層で `acs-probe` では測れない。当 PJ は立てる。
- 等価と判断した変異: Field Exit・Field± を満杯まで打った直後に押したときに編集を出す・出さない（字を打った時点で編集は出ているので、値は変わらず、出し直しの回数だけの差）。

## D5: Field Exit の「欄の先頭」は欄の型で決める（節目 10 の独立点検 B-S1）
- 測定（`scripts/acs-probe/dbcs-field-exit-me.txt`）: G は全角の最初の字で拒否（先頭）、O は SBCS の `A` を 5,10 で拒否・全角始まりは SO の桁で拒否・最初の字で通過、J は SO の次の桁（先頭でない）で通過、E は全角始まりが SO の次で通過・SBCS の `A` は先頭で拒否。
- 決定: J は常に先頭でない・E は全角で始まるときだけ・G と O は論理位置 0 を先頭とする。O の全角始まりは SO の桁と最初の字が論理位置で区別できず、Tab の着地を優先して先頭に数える（最初の字を選んだ場合だけ ACS と違う）。
- 破棄した決定: 「中身が全角で始まるなら先頭ではない」（節目 9 の J の規則を全 DBCS 欄へ広げた）は、G・O・空の J で外れた。
