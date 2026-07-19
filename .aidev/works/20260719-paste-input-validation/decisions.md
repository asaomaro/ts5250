# 決定記録

## D1: DBCS 欄の単一行ペーストは従来経路（typeChar/dbcsType）を残す

- 背景: spec E は「単一行も pasteMultiline に一本化する」としたが、DBCS 欄で
  既存テストが 2 件落ちた。`pasteMultiline` は宛先を**桁（列ビュー）**で決め、
  書き込みは `overwriteInto` が**論理文字の配列**で行う。全角は SO+2+SI=4 桁を
  占めるため両者がずれ、既存の全角を壊す
  （"ABCDEF" の 1 桁目へ "日" を貼ると `A日F` になるべきところ `A日CDEF`）。
- 決定: `isDbcsEdit(f)` が真かつ単一行のときだけ従来経路を通す。
  挿入モードの一括拒否と `No room to insert data.` はこの経路にも実装した。
- 理由 / 代替案: `overwriteInto` を列ビュー対応に書き換える案は、
  DBCS の桁計算を 2 か所（既存の dbcsType と新実装）に持つことになり、
  retro で挙げた「同じ事実の導出元を 2 つ持たない」に反する。
  正しく動いている既存経路を残す方が安全。
- 影響: **DBCS 欄の単一行ペーストには矩形折返し・横方向の割り込みが効かない。**
  spec E の適用範囲が SBCS 欄に限定される。review で明示し、
  必要なら別作業として起票する。

## D2: 上書きペーストで疎配列の穴を作らない

- 背景: 「弾いた桁を消費する」を `i++` だけで実装したところ、
  欄が空（`out` が短い）の場合に `out[i]` が未代入のまま飛び越され、
  `join("")` で穴が消えて後続が詰まった（"あ1いう2" → "12"、正: " 1  2"）。
- 決定: 弾いたときも書いたときも、`i` に届くまで空白を push してから進む。
- 理由: JS の疎配列は `join` で穴を空文字にする。桁位置を保つ実装では
  「触れない」と「存在しない」を区別する必要がある。

## D3: 保護欄でも onInputPaste を早期 return しない

- 背景: 従来 `if (f.protected) return;` でペーストを捨てていたが、
  requirement は「保護欄で始めても右の入力欄から流し込む」。
- 決定: 保護欄では編集モデルを作らず `pasteMultiline` に委ねる。
  走査（`nextWritableAt`）が右方向の宛先を見つける。

## D4: 欄外の入力・ペーストは EmulatorPane で拾う（PR #90 の取りこぼし修正）

- 背景: PR #90 は保護欄の打鍵・ペーストを `ScreenGrid` の `@keydown` / `@paste` で
  扱う実装にしたが、**実機では発火しない**。このアプリは保護欄に focus を留めず
  （`reconcileFocus` が blur してペインへ移す）、イベントは input へ届かない。
  単体テストは readonly の input へ直接イベントを送っていたため通ってしまい、
  **到達しない経路を検証していた**（PR #87 と同じ誤り）。
- 決定:
  - 操作員メッセージの定数を `composables/opMessages.ts` へ切り出し、
    ScreenGrid と EmulatorPane の双方から使う。
  - `pasteMultiline` を画面座標起点の `pasteFrom` へ一般化し、`pasteAt(row, col, text)`
    を expose。ペインの `@paste` から委譲する。
  - ペインの keydown で、欄外の文字入力・Backspace・Delete にメッセージを出す。
- 影響: テストは **EmulatorPane 起点**（実機と同じ経路）へ移した。
  ScreenGrid 単体で readonly input を叩くテストは、実機の経路を表さないため増やさない。
