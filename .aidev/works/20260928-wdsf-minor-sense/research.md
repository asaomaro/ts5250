# 調査: WDSF のマイナー構造体の否定応答

## 調査の問い
- Q1: ACS は選択欄（0x50）・窓（0x51）・罫線（0x60）のマイナー構造体のどこを検査し、どのセンスを返すか
- Q2: 当 PJ の今の実装（`wdsfShapeSense`）はどこまで検査しているか

## 判明した事実
- F1: ACS のデコンパイル済みコア（`enptui/ENPTUISelectionField.java` `processMinorStructures`）: マイナーは自分の長さを先頭に持つ並びで、
  選択肢文字列（型 0x10）は 4 バイト未満なら `sense_code=268763411`（0x10050113）、選択肢の属性（型 0x01）は 4〜19 バイトでなければ同じセンス。
  マイナーの開始位置は `checkMajorLength` の閾値と同じ（スクロール・バー付き選択欄は ACS offset 28、無ければ 20——コンストラクタの
  フィールド読み出し順〔flag1[4]・flag2[5]・flag3[6]・selectionType[7]・guiDeviceChar[8]・4予約[9-12]・textSize[13]・rows[14]・cols[15]・
  nulls[16]・予約[17]・selectChar[18]・cancelAID[19]、スクロール・バーは総数〔4バイト〕・位置〔4バイト〕を追加〕から数えた）
- F2: `enptui/ENPTUIMenuBar.java` `processMinorStructures`（`ENPTUISelectionField` を継承しつつ完全に上書き）: 同じ 2 つに加え、
  メニューバーの区切り（型 0x09）が 5〜8 バイトでなければ同じセンス。メニューバーかどうかは選択欄の主構造の `selectionType`（ACS offset 7）が
  1 のときだけ（`ENPTUI5250.processWSFOrder` の `s == 1 ? new ENPTUIMenuBar(...) : ...` — offset 7 の値で選択欄のサブクラスを決める分岐、251-267 行）
- F3: `enptui/ENPTUIWindow.java` コンストラクタ: 主構造 5 バイト（flag1[4]・flag2[5]・予約[6]・depth[7]・width[8]）の後ろ（offset 9）からマイナーが続く。
  枠の見た目（型 0x01）は 4〜13 バイトでなければ 0x10050113、表題・脚注（型 0x10）は 6 バイト以下なら同じセンス
- F4: `enptui/ENPTUI5250.java` `processDefineGridMinor`（1730-1904 行）: マイナーは `長さ(1) 型(1) フラグ(1) 行(1) 桁(1) 横罫(1) 縦罫(1) 色(1) 予約(1) 反復(1) 間隔(1)`
  の 11 バイト（バイトの読み出し順を `n` の増減で追って確定。色・予約の 2 バイトは読むだけで検査に使わない）。型は switch(0〜7)で、default（8 以上）は
  `return 0x10050150L`（呼び出し元 `processDefineGrid` の 1710-1720 行で `sense_code=戻り値` にして打ち切り）。行・桁は `s5>Rows||s5==0||s6>Cols||s6==0` で
  0x10050151。横罫（型が 2・3 以外）は `n8+s6-1>Cols||n8==0` で 0x10050151、縦罫（型が 0・1 以外）は `n9+s5-1>Rows||n9==0` で同じセンス。
  反復（型が 4・6 以外・マイナー長 10 以上のときだけ）は `n11<1` で 0x10050152、間隔（型が 4・5 以外・マイナー長 11 以上のときだけ）は `s7<1` で同じセンス
- F5: マイナー自身の長さの範囲検査は `processDefineGrid`（1661-1728 行）側:
  `if (n8 < s3 || s3 < n6(=7) || s3 > s(=11)) { sense_code=268763411; return n; }`（n8=残りバイト数、s3=このマイナーの長さ）——長さが 7〜11 バイトの外
  か残りを超えると 0x10050113 で打ち切り
- F6: 当 PJ の変更前（`packages/tn5250/src/protocol/wtd-applier.ts` の `wdsfShapeSense`）は、0x50/0x51 の主構造の長さだけ検査し
  （`len<=20`・`len<=8`）、マイナーの中身は一切検査していなかった。0x60 も主構造の長さ・区画だけで、マイナー構造体は無検査だった

## 実現性 / リスク
- 全て ACS のデコンパイル済みソースの直読（F1-F5）。**実機（DSM）での検証はこの work では行っていない**——リスクは「読み違え」で、
  それを減らすため、F1〜F5 は原典の該当メソッドを行番号つきで確認し、byte オフセットは変数 `n` の increment を 1 行ずつ追って算出した
  （最初の実装で罫線の反復・間隔のオフセットを 1 バイトずれて実装し、既存テストは通ったが再検算で誤りに気づいた——`decisions.md` D1）

## 実装アンカー
- A1: `packages/tn5250/src/protocol/wtd-applier.ts` `wdsfShapeSense`（0x50/0x51/0x60 の case）
- A2: 新設の `selectionMinorSense` / `windowMinorSense` / `gridMinorSense`（同ファイル）

## 実装時の注意
- `sf` は `[class, type, ...body]`（ACS offset 2 から）。`at(i) = sf[i-2]` の変換を、マイナーの内側の byte 位置にも一貫して使うこと
  （罫線のマイナーは主構造の後ろなので `at()` ではなく sf の素の添字で書いたほうが読みやすい——実装では素の添字 `p` を使った）

## design への申し送り
- 選択肢の属性の「値」・0x54 の CCSID 形・構造体そのものが画面の外（0x10050112）・罫線の反復/間隔つき矩形の総延長は対象外のまま残す（台帳）
