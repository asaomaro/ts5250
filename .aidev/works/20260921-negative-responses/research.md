# 調査: ACS の否定応答

## 判明した事実
- F1（原典）: `DS5250.tokenizeData` は `sense_code` が立っていれば `00 0E 12 A0 00 00 04 80 00 00 <センス 4 バイト>` を送る（ERR・フラグ 2 は 0・オペコード 0）。
  `processCommand` は `sense_code` が立つとループを抜ける。
- F2（原典）: コマンドの位置に ESC（0x04）が無い → 0x10050121。ROLL の `processRoll` が -1 → 0x1005012C。CLEAR UNIT ALTERNATE の引数が 0 でない → 0x10030101。
  WSF D9/72 のフラグ 0x80 → 0x10050112。知らないコマンドは `default: ++n5`（1 バイト読み飛ばして続ける。否定応答なし）。
- F3（実機・社内機。DSM の試験プログラム `NEGTST`。測った後に消した）: WSF D9/72 の 0x80 → ACS ではホストの `QsnPutInpCmd` が CPFA304 で戻って続き、
  修正前の当 PJ ではホストが待ち続けて施錠のまま。未知のコマンド（0xFE）と不正な ROLL → どちらもホストは rc=0。
- F4（当 PJ）: `wtd-applier.ts` は ESC が無いときも未知のコマンドのときも警告してレコードの残りを捨て、否定応答は持っていなかった。
