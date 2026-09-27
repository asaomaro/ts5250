# 決定記録

## D1: full で進め、0x21 を SOH の行で DSM に出させて測る（着手時の判断）

- 背景: `aidev-util-batch` で `acs-parity.md` の「WRITE ERROR CODE（0x21）のメッセージを、SOH が申告したメッセージ行に出す」を autonomous で起こした（直前の `20260926-window-error-code` D2 から割った項目。利用者の指示「残りもすべて autonomous で」）。
- 決定: profile は full。`20260926-window-error-code` で足した DSM の試験プログラム（`scripts/host-src/dscmd.c`）に 0x21 のモードを足し、SOH でメッセージ行を 22 に申告した画面で ACS のコアと当 PJ を比べる。
- 影響: 0x22 のときと同じ「重ねる位置」（`systemMessageArea`）を 0x21 にも付ける形になる見込み。

## D2: 1 行を超えた本文が次の行を上書きする ACS の振る舞いには合わせない

- 背景: research F3。ACS は 0x21 の本文が 1 行を超えると次の行のセルへ続けて書き、Reset で抜けてもその行は戻さない（ホストが描いた次の行の内容が失われる）。
- 決定: 合わせない。当 PJ はメッセージ行の 1 行ぶんに重ね、はみ出した分は出さない（`systemMessage` の文字列には全部残る）。
- 理由: AGENTS.md「判断の原則」1 の例外——**ACS が情報を捨てている**（ホストの次の行の内容を上書きしたまま戻さない）。合わせると当 PJ も情報を失う。例外に要る実測の裏づけは F3。
- 影響: 1 行を超える 0x21 の画面では、ACS と見た目が違う（ACS は次の行が壊れる）。台帳の項目に記録する。

## D3: T3（実機の測定と片付け）は test 工程で消化する

- 決定: coding では消化せず test 工程で行う。coding の承認時に T3 は未チェックのまま残る。

## D4: 桁の欠けた 0x22 は 0x21 と同じ位置（メッセージ行の 1 行全体）にする

- 背景: 0x22 の桁 2 バイトが欠けたレコードは、`20260926-window-error-code` で「0x21 と同じく読める範囲で」読み、位置は付けていなかった（＝最下行）。0x21 に位置を付けたので、この扱いも 0x21 に揃える必要がある。
- 決定: 桁が欠けた 0x22 は 0x21 と同じくメッセージ行の 1 行全体に重ねる（`window-error-code.test.ts` の 2 件を直した）。
  桁が不正で位置が出せない 0x22（逆転・開始桁 0 等。`windowErrorArea` が undefined）も同じにする（T1 の点検の指摘。分かれると「0x21 と同じ扱い」が崩れる）。
- 理由: 既存の方針（0x21 と同じ扱い）を変えずに保つだけ。ACS で桁の欠けた 0x22 がどう出るかは**未確認**（ホストが出す形ではない）。

## D5: メッセージ行は申告が無ければ最下行、CLEAR UNIT / CLEAR UNIT ALTERNATE / CLEAR FORMAT TABLE / SOH の入口で最下行へ戻す

- 背景: 0x21 の行を `messageLineRow` から採るようにしたところ、当 PJ の `msgLineRow` は「初期値 24・有効な SOH の申告でだけ上書き・戻さない」だった（`buffer.ts`。T1 の点検の must とも一致）。
  このままだと 27×132 では 24 行に出し（差分の前は UI が最下行＝27 に出していた）、前の画面の SOH の申告も残り続ける。
- 事実（原典）: ACS `DS5250` は `SOH_msgline_num` をコンストラクタと `processClearFMT` で `ps.GetSizeRows()`（画面の行数）にする。`processClearFMT` は CLEAR FORMAT TABLE（0x50）・`processClearUnit`（CLEAR UNIT と、画面の大きさを替えた後の CLEAR UNIT ALTERNATE）・SOH（申告を読む**前**。`processClearFMT(true,false)`）から呼ばれる。
  → design / requirements の「27×132 の既定は未確認」は原典で閉じた（最下行＝27）。
- 決定: `ScreenBuffer.resetMsgLineRow()`（`msgLineRow = rows`）を `clearFormatTable` / `clearUnit` / `clearUnitAlternate` で呼ぶ。SOH は `clearFormatTable` を `setHeaderData` より**先**に呼ぶ（ACS の順序。逆だと申告が消える）。
- 影響: `systemMessage` の寿命判定（`clearSystemMessageIfTouched`）も同じ行を見るので、27×132 と「申告の無い画面」で ACS と同じ行に揃う（副次的な改善）。tn5250 の全テスト（921 件）は緑のまま。変異 4 通り（3 か所の戻し・SOH の順序）はどれもテストで落ちる。
- 実機: 27×132 の 0x21 は実機で測っていない（原典の読みだけ）——test-result の未検証の穴に残す。

## D6: システム・メッセージの寿命は「出した行」で判定する

- 背景: cross 点検の指摘。D5 で SOH・CLEAR FORMAT TABLE のたびにメッセージ行が最下行へ戻るので、寿命を「いまの `msgLineRow`」で判定すると表示している行とずれる。
- 事実: ACS は本文をメッセージ行のセルそのものへ書き、`processClearFMT` は `SOH_msgline_num` を戻すだけで書いたセルを変えない——消えるのは書いた行が書き替わったとき。
- 決定: `clearSystemMessageIfTouched` は `systemMessageArea.row`（無ければ `msgLineRow`）で判定する。
- 範囲外: SOH の長さが 0 か 8 以上のときの扱い（ACS は打ち切り・当 PJ は消す）は既存の差として backlog へ回す。
