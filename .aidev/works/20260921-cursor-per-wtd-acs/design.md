# 仕様: カーソルの位置を WTD ごとに決める

## 設計方針
- IC / MC の番地をバッファに持ち（`icAddr` / `mcAddr`）、書式を消すとき（CLEAR UNIT・ALT・CLEAR FORMAT TABLE・SOH・画面サイズの変更）だけ捨てる。
- WTD の終わりで `placeCursorAfterWtd`: CC2 の 0x40 を持ち越し、動かしてよければ MC ?? IC ?? ホーム（欄が無ければ 0）、動かさないなら MC だけ。
- セッションの「READ のときに先頭の入力欄へ」をやめる。
- 原典の「解錠中の WTD は動かさない」は入れない（F5 の実測と合わない。decisions D2）。

## 依拠する既存の事実
- WRITE ERROR CODE を含むレコードはカーソルを受信前に戻す（`applyDataStream` の `finish`。実測済みの既存の扱い）。変えない。
- RESTORE SCREEN は保存したカーソルに戻し `cursorSet` を立てる（既存）。

## 受け入れ基準との対応
- AC1: `cursor-default.test.ts`・`cursor-split-record.test.ts`。実機 `verify-read-split-record.mjs`。
- AC2: `verify-cursor-screens.mjs` と `acs-probe/cursor-screens.txt` の突き合わせ。`verify-read-only-cursor.mjs`（QSH）。
- AC3: mutation。
