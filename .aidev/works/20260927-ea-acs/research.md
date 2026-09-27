# 調査: EA の扱い

## 調査の問い
- Q1: ACS の EA の処理（原典）
- Q2: 実機での ACS のコアと当 PJ

## 判明した事実
- F1（Q1・原典 `PS5250.eraseToAddress` と `DS5250.processWriteToDisplay` の EA）: 属性タイプ（長さ −1 個）ごとに `eraseToAddress(行き先, タイプ)` を呼ぶ。
  行き先が今の位置より前なら 1（→ 0x10050123）。0x00・0xFF は今の位置〜行き先を消す（DBCS のセッションの 0xFF は区間の印も）。0x05 は DBCS のセッションだけ区間の印を消し、それ以外は 2（→ 0x1005012D）。その他のタイプも 2。
  成功すれば今の位置を**行き先の次**にする——2 つ目のタイプは必ず「前」になる。
- F2（Q2・実測。2026-09-27・社内機）: DSM（`scripts/host-src/dscmd.c` の EATEST*）で「6 行 2 桁に ABCDEFGHIJ → SBA 6,4 → EA〔行き先 6,6〕→ X → 6,20 に END」を 1 WTD（CC2＝メッセージ待ち）で出させた。
  **ACS のコア**（`scripts/acs-probe/ea-acs.txt`・ワイヤは `tap-proxy.mjs`。記録は読み終えて消した）: 0xFF・0x00 → ` AB   XGHIJ        END`（C〜E を消し X は 6,7）・否定応答なし。
  0x01 → ` ABCDEFGHIJ`・0x1005012D。長さ 3（0x00・0xFF）→ ` AB   FGHIJ`（1 つ目で消し、2 つ目で）0x10050123。どれも mw=true。
  **当 PJ（直す前）**: 4 通りとも ` AB  XFGHIJ        END`（X は行き先の 6,6）・否定応答なし。
- F3（Q2・実測。直した後）: 当 PJ も 4 通りとも ACS と同じ（`scripts/verify-ea-acs.mjs` pass=12）。
- F4（T1 の点検の後・実測）: 行き先が画面の最後の桁（EA 24,80）の後ろに X（EATESTEND）→ ACS のコアは消去は効かせ（24 行目は 70〜74 桁の 01234 だけ）、X は書かず、0x10050121・mw=false（CC2 を落とす）。
  24,79 から XYZ（EATESTOVER）→ 並びの全部を書かず（24 行目は空）、0x10050121・mw=false。→ **ESC とオーダー以外のバイトの並びが画面の終わりを越えると、ACS は並びを書かずにその場で戻る**。
  当 PJ（直す前）は画面の外の書き込みの例外でレコードの結果ごと捨てていた（否定応答なし）。直した後は 6 通りとも ACS と同じ（pass=20）。
  **「並びを書かず」は見える文字（TextPlane）の実測**——原典では手前の桁の HostPlane と並びの中の属性は書かれている見込み（D2 の既知の差）。
- F5（review ラウンド 1 の後・原典と実測）: ACS の `PS5250.writeString` は書いた後に位置を画面の大きさで割った余りにする（`eraseToAddress` だけは割らない）。
  24,78 から XYZ → IC 6,2 → W（EATESTWRAP）→ ACS のコアは W を 1,1 に書き、否定応答なし・mw=true。当 PJ も直した後は同じ（7 通りで pass=25）。

## 影響範囲
- `packages/tn5250/src/protocol/wtd-applier.ts` の EA。既存テスト `wtd-applier.test.ts` の EA（長さ 3 を読み飛ばす形）

## 実現性 / リスク
- 長さ 3 以上の EA は ACS では否定応答になる——ホストの表示装置ファイルが出す EA が長さ 2 か未確認だが、ACS と同じなら欠陥ではない

## 実装アンカー
- A1: `applyWtd` の `case ORDER.EA`（`wtd-applier.ts`）

## design への申し送り
- なし
